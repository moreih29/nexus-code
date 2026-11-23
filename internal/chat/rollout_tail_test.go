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

// writeRollout writes a thread's rollout where Codex keeps it.
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

// told is the events as a line each, to compare.
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

// What Codex before 0.16x wrote: an event for each message and tool call.
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

	// All of it, and no more before it.
	all := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 4})
	if all.More || len(all.Events) != 4*len(oldTurnTold(1)) {
		t.Fatalf("more %v, %d events", all.More, len(all.Events))
	}
	// Three turns when none are asked for.
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
		"agent t1 보는 중",
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
	// What the parent went on to after the fork is not the fork's.
	writeRollout(t, home, tailParent, append(parent, oldTurn(9)...)...)
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":"%s","forked_from_id":"%s","history_base":{"end_byte_offset":%d}}}`, tailThread, tailParent, forkedAt)
	writeRollout(t, home, tailThread, append([]string{meta}, oldTurn(3)...)...)

	got := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 2})
	if !got.More {
		t.Fatal("the parent's first turn was not told as more")
	}
	sameLines(t, told(got.Events), append(oldTurnTold(2), oldTurnTold(3)...))

	// The fork's own turn alone: what the parent holds is more.
	one := rolloutTailOf(t, RolloutTailParams{ThreadID: tailThread, CodexHome: home, Turns: 1})
	if !one.More {
		t.Fatal("a fork's history was not told as more")
	}
	sameLines(t, told(one.Events), oldTurnTold(3))

	// All three, and nothing before them.
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
	long := strings.Repeat("가", rolloutTailText) // three bytes each
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

// A turn whose output is past what is read is cut, and told as more.
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
