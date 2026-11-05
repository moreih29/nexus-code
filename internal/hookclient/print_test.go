package hookclient

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// sessionA is a session id, as claude makes them.
const sessionA = "8f7b63e3-a0e6-4b44-af95-03c2697fe716"

func TestDescribePrintRun(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "")
	cases := []struct {
		name string
		args []string
		want printRun
	}{
		{
			"the prompt after -p, and the run's format and model",
			[]string{"-p", "review it", "--bare", "--output-format", "stream-json", "--verbose", "--model", "glm-4.6"},
			printRun{prompt: "review it", model: "glm-4.6", format: "stream-json"},
		},
		{
			"the prompt first, options with =",
			[]string{"review it", "--print", "--output-format=json", "--model=opus"},
			printRun{prompt: "review it", model: "opus", format: "json"},
		},
		{
			"no prompt told apart after an option",
			[]string{"-p", "--allowedTools", "Bash", "Read", "review it"},
			printRun{format: "text"},
		},
		{
			"the prompt after --",
			[]string{"-p", "--model", "opus", "--", "-review it"},
			printRun{prompt: "-review it", model: "opus", format: "text"},
		},
		{
			"the session id it was given",
			[]string{"-p", "hi", "--session-id", "s1"},
			printRun{prompt: "hi", format: "text", sessionID: "s1"},
		},
		{
			"a session id with =",
			[]string{"--session-id=s1", "-p", "hi"},
			printRun{prompt: "hi", format: "text", sessionID: "s1"},
		},
		{
			"a run that goes on a session by its id",
			[]string{"-p", "hi", "--resume", sessionA},
			printRun{prompt: "hi", format: "text", sessionID: sessionA, resumed: true},
		},
		{
			"-r and its id",
			[]string{"-r", sessionA, "-p", "hi"},
			printRun{prompt: "hi", format: "text", sessionID: sessionA, resumed: true},
		},
		{
			"--resume= and its id",
			[]string{"--resume=" + sessionA, "-p", "hi"},
			printRun{prompt: "hi", format: "text", sessionID: sessionA, resumed: true},
		},
		{
			"a run that goes on a session found by a search term",
			[]string{"-p", "hi", "--resume=s1"},
			printRun{prompt: "hi", format: "text", noTranscript: true},
		},
		{
			"a run that goes on the latest session",
			[]string{"-c", "-p", "hi"},
			printRun{prompt: "hi", format: "text", noTranscript: true},
		},
		{
			"a fork of a session, which starts one of its own",
			[]string{"-p", "hi", "--resume", sessionA, "--fork-session"},
			printRun{prompt: "hi", format: "text"},
		},
		{
			"a fork of the latest session, given its id",
			[]string{"-c", "--fork-session", "--session-id", "s2", "-p", "hi"},
			printRun{prompt: "hi", format: "text", sessionID: "s2"},
		},
		{
			"a run that keeps no session",
			[]string{"-p", "hi", "--no-session-persistence"},
			printRun{prompt: "hi", format: "text", noTranscript: true},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := describePrintRun(c.args); got != c.want {
				t.Fatalf("describePrintRun(%q) = %+v, want %+v", c.args, got, c.want)
			}
		})
	}

	t.Run("the model claude would take from its environment", func(t *testing.T) {
		t.Setenv("ANTHROPIC_MODEL", "glm-4.6")
		if got := describePrintRun([]string{"-p", "hi"}).model; got != "glm-4.6" {
			t.Fatalf("model = %q", got)
		}
	})
}

// streamLines is a stream-json run's output as Claude Code 2.1.316 prints
// it, cut to the fields read.
var streamLines = []string{
	`{"type":"system","subtype":"ui_invalidate","event":"ui.render"}`,
	`{"type":"system","subtype":"init","cwd":"/repo","session_id":"s1","tools":["Bash"],"model":"glm-4.6"}`,
	`{"type":"assistant","message":{"model":"glm-4.6","content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls","description":"List files"}}]},"parent_tool_use_id":null}`,
	`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"a.ts","is_error":false}]}}`,
	`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/repo/missing.ts"}}]}}`,
	`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":[{"type":"text","text":"File does not exist.\nMore"}],"is_error":true}]}}`,
	`{"type":"user","message":{"role":"user","content":"a prompt replayed"}}`,
	`{"type":"result","subtype":"success","is_error":false,"result":" Done. ","num_turns":3}`,
}

type toldFrame struct {
	Subcommand string
	Payload    map[string]any
}

func TestPrintWatch_TellsTheRunsToolsAndAnswer(t *testing.T) {
	var told []toldFrame
	watch := &printWatch{tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}}
	for _, line := range streamLines {
		watch.line([]byte(line))
	}
	watch.line([]byte("not json"))
	want := []toldFrame{
		{"print-init", map[string]any{"model": "glm-4.6", "cwd": "/repo", "session_id": "s1"}},
		{"print-tool-use", map[string]any{
			"tool_use_id": "toolu_1",
			"tool_name":   "Bash",
			"tool_input":  map[string]any{"command": "ls", "description": "List files"},
		}},
		{"print-tool-result", map[string]any{"tool_use_id": "toolu_1", "is_error": false}},
		{"print-tool-use", map[string]any{
			"tool_use_id": "toolu_2",
			"tool_name":   "Read",
			"tool_input":  map[string]any{"file_path": "/repo/missing.ts"},
		}},
		{"print-tool-result", map[string]any{
			"tool_use_id": "toolu_2",
			"is_error":    true,
			"error":       "File does not exist.\nMore",
		}},
	}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("told:\n%#v\nwant:\n%#v", told, want)
	}
	if watch.answer != "Done." {
		t.Fatalf("answer = %q", watch.answer)
	}
}

// transcriptLines are a run's transcript as Claude Code 2.1.316 writes it,
// cut to the fields read: a message a line, each with its directory.
var transcriptLines = []string{
	`{"type":"queue-operation","operation":"enqueue","content":"review it"}`,
	`{"type":"user","message":{"role":"user","content":"review it"},"cwd":"/repo"}`,
	`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"x"}]},"cwd":"/repo"}`,
	`{"type":"assistant","message":{"model":"glm-4.6","content":[{"type":"text","text":"Looking."}]},"cwd":"/repo"}`,
	`{"type":"assistant","message":{"model":"glm-4.6","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/repo/a.ts"}}]},"cwd":"/repo"}`,
	`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"File does not exist.","is_error":true}]},"cwd":"/repo"}`,
	`{"type":"assistant","message":{"model":"glm-4.6","content":[{"type":"text","text":"It is fine."}]},"cwd":"/repo"}`,
	`{"type":"assistant","message":{"model":"glm-4.6","content":[{"type":"text","text":"Ship it."}]},"cwd":"/repo"}`,
	`{"type":"last-prompt","lastPrompt":"review it"}`,
}

func TestPrintWatch_ReadsATranscript(t *testing.T) {
	var told []toldFrame
	watch := &printWatch{tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}}
	for _, line := range transcriptLines {
		watch.line([]byte(line))
	}
	want := []toldFrame{
		{"print-init", map[string]any{"model": "glm-4.6", "cwd": "/repo"}},
		{"print-tool-use", map[string]any{
			"tool_use_id": "toolu_1",
			"tool_name":   "Read",
			"tool_input":  map[string]any{"file_path": "/repo/a.ts"},
		}},
		{"print-tool-result", map[string]any{
			"tool_use_id": "toolu_1",
			"is_error":    true,
			"error":       "File does not exist.",
		}},
	}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("told:\n%#v\nwant:\n%#v", told, want)
	}
	// Its answer is what claude wrote after its last tool.
	if watch.reply != "It is fine.\nShip it." || watch.answer != "" {
		t.Fatalf("reply = %q, answer = %q", watch.reply, watch.answer)
	}
}

func TestNewSessionID_IsAUUID(t *testing.T) {
	id := newSessionID()
	if len(id) != 36 || id[14] != '4' || !strings.Contains("89ab", string(id[19])) || id == newSessionID() {
		t.Fatalf("id = %q", id)
	}
}

func TestTrimInput_CutsLongStrings(t *testing.T) {
	long := strings.Repeat("x", printTextMax+10)
	input, _ := json.Marshal(map[string]any{"file_path": "/a", "content": long, "n": 3})
	got := trimInput(input).(map[string]any)
	if got["file_path"] != "/a" || got["n"] != float64(3) {
		t.Fatalf("trimInput kept %#v", got)
	}
	if content := got["content"].(string); len([]rune(content)) != printTextMax+1 {
		t.Fatalf("content not cut: %d", len([]rune(content)))
	}
	if !reflect.DeepEqual(trimInput(json.RawMessage(`"x"`)), map[string]any{}) {
		t.Fatal("an input not an object is told as none")
	}
}

func TestPassOutput_PassesItAsItComesAndReadsLines(t *testing.T) {
	var out bytes.Buffer
	var lines []string
	input := "one\ntwo" + strings.Repeat("y", 10) + "\nlast"
	passOutput(strings.NewReader(input), &out, func(b []byte) { lines = append(lines, string(b)) })
	if out.String() != input {
		t.Fatalf("output = %q", out.String())
	}
	want := []string{"one", "two" + strings.Repeat("y", 10), "last"}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q", lines)
	}
}

type failingWriter struct{ writes int }

func (w *failingWriter) Write(p []byte) (int, error) {
	w.writes++
	return 0, bytes.ErrTooLarge
}

func TestPassOutput_StopsWhenNoOneReads(t *testing.T) {
	w := &failingWriter{}
	read := 0
	passOutput(strings.NewReader("one\ntwo\n"), w, func([]byte) { read++ })
	if w.writes != 1 || read != 0 {
		t.Fatalf("writes=%d lines=%d", w.writes, read)
	}
}
