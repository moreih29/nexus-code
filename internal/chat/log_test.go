package chat

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestReplayPinsKeepClaudeStateWithinTheRollingCap(t *testing.T) {
	log := newLineLog()
	log.cap = 256
	start := log.add(DirSys, json.RawMessage(`{"event":"start"}`), "")
	control := func(id, subtype, fields, answer string) (*entry, *entry) {
		input := json.RawMessage(fmt.Sprintf(`{"type":"control_request","request_id":%q,"request":{"subtype":%q%s}}`, id, subtype, fields))
		request := log.reserveInput(input)
		log.finishInput(request, DirIn, input)
		response := log.add(DirOut, json.RawMessage(fmt.Sprintf(`{"type":"control_response","response":{"request_id":%q,%s}}`, id, answer)), "")
		return request, response
	}
	fill := func() {
		for i := 0; i < 5; i++ {
			log.add(DirOut, json.RawMessage(`{"type":"assistant"}`), strings.Repeat("a", 64))
		}
	}
	const ok = `"subtype":"success"`
	initialize, initialized := control("init", "initialize", "", ok+`,"response":{"commands":[{"name":"compact"}],"models":[{"value":"opus"}]}`)
	oldSystem := log.add(DirOut, json.RawMessage(`{"type":"system","subtype":"init","model":"old"}`), "")
	oldModel, oldModelAnswer := control("old", "set_model", `,"model":"old"`, ok)
	for i := 0; i < 40; i++ {
		control(fmt.Sprintf("choose-%d", i), "set_model", `,"model":"sonnet"`, ok)
		fill()
	}
	system := log.add(DirOut, json.RawMessage(`{"type":"system","subtype":"init","model":"opus"}`), "")
	model, modelAnswer := control("new", "set_model", `,"model":"opus"`, ok)
	control("bad", "set_model", `,"model":"refused"`, `"subtype":"error"`)
	mode, modeAnswer := control("mode", "set_permission_mode", `,"mode":"plan"`, ok)
	bypass, bypassAnswer := control("bypass", "set_permission_mode", `,"mode":"bypassPermissions"`, `"subtype":"error","error":"blocked"`)
	status := log.add(DirOut, json.RawMessage(`{"type":"system","subtype":"status","permissionMode":"default"}`), "")
	settings, settingsAnswer := control("settings", "get_settings", "", ok+`,"response":{"applied":{"effort":"medium"}}`)
	effort, effortAnswer := control("effort", "apply_flag_settings", `,"settings":{"effortLevel":"xhigh"}`, ok)
	control("flags", "apply_flag_settings", `,"settings":{"permissions":{}}`, ok)
	remote, remoteAnswer := control("remote", "remote_control", `,"enabled":true`, ok)
	cleared := log.add(DirOut, json.RawMessage(`{"type":"conversation_reset"}`), "")
	fill()

	want := []*entry{start, initialize, initialized, system, model, modelAnswer, mode, modeAnswer,
		bypass, bypassAnswer, status, settings, settingsAnswer, effort, effortAnswer, remote, remoteAnswer, cleared}
	var got []*entry
	var regularBytes, pinnedBytes int
	for _, line := range log.since(0) {
		if line == oldSystem || line == oldModel || line == oldModelAnswer {
			t.Fatalf("obsolete state is still present at sequence %d", line.seq)
		}
		if line.pins > 0 {
			got = append(got, line)
			pinnedBytes += line.size()
		} else {
			regularBytes += line.size()
		}
	}
	if len(got) != len(want) {
		t.Fatalf("%d pinned lines, want %d", len(got), len(want))
	}
	for i, line := range want {
		if got[i] != line {
			t.Errorf("pin %d: sequence %d, want %d", i, got[i].seq, line.seq)
		}
	}
	if !log.truncated || log.bytes != regularBytes || regularBytes > log.cap || pinnedBytes <= log.cap || len(log.requests) != 0 {
		t.Fatalf("truncated=%t, regular=%d, counted=%d, pinned=%d, pending=%d", log.truncated, regularBytes, log.bytes, pinnedBytes, len(log.requests))
	}
	t.Logf("%d pinned lines, %d bytes including entry overhead", len(got), pinnedBytes)
	log.reset()
	if len(log.entries) != 0 || len(log.replayPins) != 0 || log.bytes != 0 || log.truncated {
		t.Fatal("reset kept replay state")
	}
}

func TestReplayPinsRetainTheLatestConnectionChangeAcrossRestarts(t *testing.T) {
	log := newLineLog()
	log.cap = 100
	add := func(message string) *entry { return log.add(DirSys, json.RawMessage(message), "") }
	oldConnection := add(`{"event":"start","connectionChanged":true,"pid":1}`)
	connection := add(`{"event":"start","connectionChanged":true,"pid":2}`)
	add(`{"event":"exit"}`)
	add(`{"event":"start","pid":3}`)
	add(`{"event":"exit"}`)
	latest := add(`{"event":"start","pid":4}`)
	log.add(DirOut, json.RawMessage(`{"type":"assistant"}`), "")
	entries := log.since(0)
	if len(entries) != 3 || entries[0] != connection || entries[1] != latest || oldConnection.pins != 0 {
		t.Fatal("the most recent connection change and process start must survive trimming")
	}
}

func TestReplayPinsHandleAnEarlyReplyAndConfirmedInput(t *testing.T) {
	for _, confirmed := range []bool{true, false} {
		t.Run(fmt.Sprintf("confirmed=%t", confirmed), func(t *testing.T) {
			log := newLineLog()
			log.cap = 120
			input := json.RawMessage(`{"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}`)
			slot := log.reserveInput(input)
			reply := log.add(DirOut, json.RawMessage(`{"type":"control_response","response":{"request_id":"init","subtype":"success"}}`), "")
			for i := 0; i < 5; i++ {
				log.add(DirOut, json.RawMessage(`{"type":"assistant"}`), "")
			}
			if confirmed {
				log.finishInput(slot, DirIn, input)
				if first := log.since(0); len(first) != 3 || first[0] != slot || first[1] != reply {
					t.Fatal("initialize pair was not retained in order")
				}
			} else {
				log.finishInput(slot, DirSys, json.RawMessage(`{"event":"stdin-failed"}`))
				if got := log.since(0); len(got) != 1 || got[0].seq <= reply.seq {
					t.Fatal("failed initialize was retained as replay state")
				}
			}
		})
	}
}

func TestLogCapDropsOldestLines(t *testing.T) {
	log := newLineLog()
	log.cap = 1000
	for i := 0; i < 50; i++ {
		log.add(DirOut, json.RawMessage(fmt.Sprintf(`{"type":"assistant","n":%d}`, i)), "")
	}
	if !log.truncated || log.bytes > log.cap {
		t.Fatalf("truncated %v, bytes %d", log.truncated, log.bytes)
	}
	entries := log.since(0)
	if got := string(entries[len(entries)-1].message); got != `{"type":"assistant","n":49}` {
		t.Fatalf("newest = %s", got)
	}
	if entries[0].seq == 1 {
		t.Fatal("oldest line kept")
	}
}

func TestLogKeepsStreamOfMessageInProgress(t *testing.T) {
	log := newLineLog()
	log.add(DirOut, json.RawMessage(`{"type":"stream_event","n":1}`), "")
	log.add(DirIn, json.RawMessage(`{"type":"user"}`), "")
	log.add(DirOut, json.RawMessage(`{"type":"assistant"}`), "")
	log.add(DirOut, json.RawMessage(`{"type":"stream_event","n":2}`), "")
	var kinds []string
	for _, e := range log.since(0) {
		kinds = append(kinds, messageType(e.message))
	}
	if got := strings.Join(kinds, ","); got != "user,assistant,stream_event" {
		t.Fatalf("log = %s", got)
	}
}

func TestMessageType(t *testing.T) {
	cases := map[string]string{
		`{"type":"assistant","message":{}}`:        "assistant",
		`{"message":{"type":"x"},"type":"result"}`: "result",
		`{"type":"a\"b"}`:                          `a"b`,
		`not json`:                                 "",
	}
	for input, want := range cases {
		if got := messageType(json.RawMessage(input)); got != want {
			t.Errorf("messageType(%s) = %q, want %q", input, got, want)
		}
	}
}
