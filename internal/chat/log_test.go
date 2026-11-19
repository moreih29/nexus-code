package chat

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

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
