package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

const (
	tailThread = "01a1c494-518d-7651-938d-00031c0ec9fb"
	tailParent = "01a1c494-518d-7651-938d-00031c0ec9fa"
)

func writeRollout(t *testing.T, home, id string, lines ...string) string {
	t.Helper()
	path := filepath.Join(home, "sessions", "2026", "11", "10", "rollout-2026-11-10T17-30-17-"+id+".jsonl")
	writeTestFile(t, path, strings.Join(lines, "\n")+"\n")
	return path
}

func rolloutTailOf(t *testing.T, params RolloutTailParams) RolloutTailResult {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := New().RolloutTail(context.Background(), raw)
	if err != nil {
		t.Fatalf("RolloutTail(%+v): %v", params, err)
	}
	return result.(RolloutTailResult)
}

func told(events []RolloutEvent) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		line := e.Kind
		for _, part := range []string{e.TurnID, e.Text, e.Tool, e.Server, e.Name, e.ClientID, strings.Join(e.Changes, ",")} {
			if part != "" {
				line += " " + part
			}
		}
		if e.Images > 0 {
			line += fmt.Sprintf(" images=%d", e.Images)
		}
		out = append(out, line)
	}
	return out
}

func sameLines(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

const tailMeta = `{"type":"session_meta","payload":{"id":"` + tailThread + `"}}`

func oldTurn(n int) []string {
	return []string{
		fmt.Sprintf(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-%d"}}`, n),
		fmt.Sprintf(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"q%d"}]}}`, n),
		fmt.Sprintf(`{"type":"event_msg","payload":{"type":"user_message","message":"q%d","images":["a"],"local_images":["b"]}}`, n),
		`{"type":"event_msg","payload":{"type":"agent_reasoning","text":"thinking"}}`,
		`{"type":"event_msg","payload":{"type":"exec_command_end","call_id":"c1","aggregated_output":"long output"}}`,
		`{"type":"event_msg","payload":{"type":"patch_apply_end","changes":{"/b.ts":{"type":"update"},"/a.ts":{"type":"add"}}}}`,
		`{"type":"event_msg","payload":{"type":"mcp_tool_call_end","invocation":{"server":"docs","tool":"search"}}}`,
		`{"type":"event_msg","payload":{"type":"web_search_end","query":"x"}}`,
		fmt.Sprintf(`{"type":"event_msg","payload":{"type":"agent_message","message":"a%d"}}`, n),
		`{"type":"event_msg","payload":{"type":"token_count","info":null}}`,
		fmt.Sprintf(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-%d"}}`, n),
	}
}

func oldTurnTold(n int) []string {
	return []string{
		fmt.Sprintf("turn turn-%d", n),
		fmt.Sprintf("user q%d images=2", n),
		"tool commandExecution",
		"tool fileChange add,update",
		"tool mcpToolCall docs search",
		"tool webSearch",
		fmt.Sprintf("agent a%d", n),
	}
}

func TestRolloutTailReadsTheLastTurnsOfAnOlderCodex(t *testing.T) {
	home := t.TempDir()
	lines := []string{tailMeta}
	for n := 1; n <= 4; n++ {
		lines = append(lines, oldTurn(n)...)
	}
	writeRollout(t, home, tailThread, lines...)

	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 2})
	if !got.Found || !got.More {
		t.Fatalf("found %v, more %v", got.Found, got.More)
	}
	sameLines(t, told(got.Events), append(oldTurnTold(3), oldTurnTold(4)...))

	all := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 4})
	if all.More || len(all.Events) != 4*len(oldTurnTold(1)) {
		t.Fatalf("more %v, %d events", all.More, len(all.Events))
	}
	if def := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home}); !def.More || len(def.Events) != 3*len(oldTurnTold(1)) {
		t.Fatalf("default: more %v, %d events", def.More, len(def.Events))
	}
}

func TestRolloutTailReadsItemsOfANewerCodex(t *testing.T) {
	home := t.TempDir()
	item := func(turn, body string) string {
		return `{"type":"event_msg","payload":{"type":"item_completed","turn_id":"` + turn + `","item":` + body + `}}`
	}
	writeRollout(t, home, tailThread,
		tailMeta,
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`,
		item("t1", `{"type":"UserMessage","client_id":"m1","content":[{"type":"text","text":"첫 줄"},{"type":"image","image_url":"data:"},{"type":"text","text":"둘째 줄"}]}`),
		item("t1", `{"type":"Reasoning","summary_text":["hm"]}`),
		item("t1", `{"type":"AgentMessage","phase":"commentary","content":[{"type":"Text","text":"보는 중"}]}`),
		item("t1", `{"type":"CommandExecution","command":"ls","aggregated_output":"x"}`),
		item("t1", `{"type":"FileChange","changes":{"/z":{"type":"delete"}}}`),
		item("t1", `{"type":"Extension","kind":"web.search"}`),
		item("t1", `{"type":"Extension","kind":"other"}`),
		item("t1", `{"type":"ImageView","path":"/a.png"}`),
		item("t1", `{"type":"McpToolCall","server":"docs","tool":"read"}`),
		item("t1", `{"type":"AgentMessage","phase":"final_answer","content":[{"type":"Text","text":"끝"}]}`),
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}`,
	)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home})
	if !got.Found || got.More {
		t.Fatalf("found %v, more %v", got.Found, got.More)
	}
	sameLines(t, told(got.Events), []string{
		"turn t1",
		"user t1 첫 줄\n둘째 줄 m1 images=1",
		"tool t1 commandExecution",
		"tool t1 fileChange delete",
		"tool t1 webSearch",
		"tool t1 imageView",
		"tool t1 mcpToolCall docs read",
		"agent t1 끝",
	})
}

func TestRolloutTailFollowsAForkIntoTheThreadItCameFrom(t *testing.T) {
	home := t.TempDir()
	parent := append([]string{`{"type":"session_meta","payload":{"id":"` + tailParent + `"}}`}, oldTurn(1)...)
	parent = append(parent, oldTurn(2)...)
	forkedAt := int64(len(strings.Join(parent, "\n")) + 1)
	writeRollout(t, home, tailParent, append(parent, oldTurn(9)...)...)
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":"%s","forked_from_id":"%s","history_base":{"end_byte_offset":%d}}}`, tailThread, tailParent, forkedAt)
	writeRollout(t, home, tailThread, append([]string{meta}, oldTurn(3)...)...)

	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 2})
	if !got.More {
		t.Fatal("the parent's first turn was not told as more")
	}
	sameLines(t, told(got.Events), append(oldTurnTold(2), oldTurnTold(3)...))

	one := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 1})
	if !one.More {
		t.Fatal("a fork's history was not told as more")
	}
	sameLines(t, told(one.Events), oldTurnTold(3))

	all := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 5})
	if all.More {
		t.Fatal("more than the thread holds")
	}
	sameLines(t, told(all.Events), append(append(oldTurnTold(1), oldTurnTold(2)...), oldTurnTold(3)...))
}

func TestRolloutTailOfAForkWhoseParentIsGone(t *testing.T) {
	home := t.TempDir()
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":"%s","forked_from_id":"%s","history_base":{"end_byte_offset":100}}}`, tailThread, tailParent)
	writeRollout(t, home, tailThread, append([]string{meta}, oldTurn(3)...)...)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 3})
	if !got.Found || !got.More {
		t.Fatalf("found %v, more %v", got.Found, got.More)
	}
	sameLines(t, told(got.Events), oldTurnTold(3))
}

func TestRolloutTailFindsNoThread(t *testing.T) {
	home := t.TempDir()
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home})
	if got.Found || got.More || got.Events == nil || len(got.Events) != 0 {
		t.Fatalf("got %+v", got)
	}
	raw, _ := json.Marshal(RolloutTailParams{ThreadID: "../../etc/passwd", CodexHome: home})
	if _, err := New().RolloutTail(context.Background(), raw); err == nil {
		t.Fatal("a path was taken as a thread id")
	}
}

func TestRolloutTailReadsAStagedCopy(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "sessions", stagedDir, "rollout-2026-11-10T17-30-17-"+tailThread+".jsonl")
	writeTestFile(t, path, strings.Join(append([]string{tailMeta}, oldTurn(1)...), "\n")+"\n")
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home})
	sameLines(t, told(got.Events), oldTurnTold(1))
}

func TestRolloutTailCutsALongMessageInsideNoCharacter(t *testing.T) {
	home := t.TempDir()
	long := strings.Repeat("가", rolloutTailText)
	body, _ := json.Marshal(long)
	writeRollout(t, home, tailThread,
		tailMeta,
		`{"type":"event_msg","payload":{"type":"user_message","message":"q"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":`+string(body)+`}}`,
	)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home})
	if len(got.Events) != 2 {
		t.Fatalf("%d events", len(got.Events))
	}
	text := got.Events[1].Text
	if len(text) > rolloutTailText || len(text) < rolloutTailText-3 || !utf8.ValidString(text) {
		t.Fatalf("cut to %d bytes, valid %v", len(text), utf8.ValidString(text))
	}
}

func TestRolloutTailStopsAtItsScanBudget(t *testing.T) {
	home := t.TempDir()
	huge := `{"type":"response_item","payload":{"type":"function_call_output","output":"` + strings.Repeat("x", rolloutTailScanBytes) + `"}}`
	lines := append([]string{tailMeta}, oldTurn(1)...)
	lines = append(lines, huge)
	lines = append(lines, oldTurn(2)...)
	writeRollout(t, home, tailThread, lines...)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 3})
	if !got.More {
		t.Fatal("what was not read was not told as more")
	}
	sameLines(t, told(got.Events), oldTurnTold(2))
}

func TestRolloutTailSendsOnlyATurnsLastWords(t *testing.T) {
	home := t.TempDir()
	body, _ := json.Marshal(strings.Repeat("<", rolloutTailText))
	lines := []string{tailMeta}
	for turn := 1; turn <= 3; turn++ {
		lines = append(lines, fmt.Sprintf(`{"type":"event_msg","payload":{"type":"user_message","message":"q%d"}}`, turn))
		for i := 0; i < 40; i++ {
			lines = append(lines, `{"type":"event_msg","payload":{"type":"agent_message","message":`+string(body)+`}}`)
			lines = append(lines, `{"type":"event_msg","payload":{"type":"exec_command_end"}}`)
		}
		lines = append(lines, fmt.Sprintf(`{"type":"event_msg","payload":{"type":"agent_message","message":"done %d"}}`, turn))
		lines = append(lines, `{"type":"event_msg","payload":{"type":"agent_message","message":"  "}}`)
	}
	writeRollout(t, home, tailThread, lines...)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 3})
	encoded, _ := json.Marshal(got)
	if len(encoded) > 64<<10 {
		t.Fatalf("the answer takes %d bytes", len(encoded))
	}
	agents := []string{}
	tools := 0
	for _, event := range got.Events {
		switch event.Kind {
		case "agent":
			agents = append(agents, event.Text)
		case "tool":
			tools++
		}
	}
	if strings.Join(agents, ",") != "done 1,done 2,done 3" || tools != 120 || got.More {
		t.Fatalf("agents %v, %d tools, more %v", agents, tools, got.More)
	}
}

func TestRolloutTailAnswerIsBounded(t *testing.T) {
	home := t.TempDir()
	body, _ := json.Marshal(strings.Repeat("<", rolloutTailText))
	lines := []string{tailMeta}
	for turn := 1; turn <= rolloutTailMaxTurns; turn++ {
		lines = append(lines, `{"type":"event_msg","payload":{"type":"user_message","message":`+string(body)+`}}`)
		lines = append(lines, `{"type":"event_msg","payload":{"type":"agent_message","message":`+string(body)+`}}`)
	}
	writeRollout(t, home, tailThread, lines...)
	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: rolloutTailMaxTurns})
	encoded, _ := json.Marshal(got)
	if len(encoded) > rolloutTailBytes+1024 {
		t.Fatalf("the answer takes %d bytes", len(encoded))
	}
	if !got.More || len(got.Events) == 0 || len(got.Events)%2 != 0 || got.Events[0].Kind != "user" {
		t.Fatalf("more %v, %d events, first %q", got.More, len(got.Events), got.Events[0].Kind)
	}
	if len(got.Events) >= 2*rolloutTailMaxTurns {
		t.Fatal("no turn was left out")
	}

	events := []RolloutEvent{{Kind: "user", Text: "q"}}
	for i := 0; i < 100; i++ {
		events = append(events, RolloutEvent{Kind: "tool", Tool: "commandExecution", Name: fmt.Sprint(i)})
	}
	fitted, cut := fitRolloutEvents(events, 1000)
	size, _ := json.Marshal(fitted)
	if !cut || len(fitted) == 0 || len(size) > 1000 || fitted[len(fitted)-1].Name != "99" {
		t.Fatalf("cut %v, %d events, %d bytes", cut, len(fitted), len(size))
	}
	if whole, cut := fitRolloutEvents(events, 1<<20); cut || len(whole) != len(events) {
		t.Fatal("an answer within its bound was cut")
	}
}
