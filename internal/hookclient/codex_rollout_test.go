package hookclient

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// rolloutLines are a text run's rollout as codex 0.166 writes it, cut to the
// fields read.
var rolloutLines = []string{
	`{"type":"session_meta","payload":{"id":"01a1b1e2","originator":"codex_exec"}}`,
	`{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"Make note.txt"}]},"started_at_ms":100,"completed_at_ms":100}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"msg_1","content":[{"type":"Text","text":"I'll create note.txt, then run ls."}],"phase":"commentary"},"started_at_ms":200,"completed_at_ms":900}}`,
	`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I'll create note.txt, then run ls."}]}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"exec-1","changes":{"/w/note.txt":{"type":"add","content":"hi\n"},"/w/a.ts":{"type":"update","unified_diff":"@@"}},"status":"completed"},"started_at_ms":1000,"completed_at_ms":1001}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"exec-2","command":["/bin/bash","-lc","npm test"],"status":"completed","aggregated_output":"FAIL a.test.ts\n","exit_code":1},"started_at_ms":2000,"completed_at_ms":6500}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","id":"r1","summary":[]}}}`,
	`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"msg_2","content":[{"type":"Text","text":"DONE"}],"phase":"final_answer"},"started_at_ms":7000,"completed_at_ms":7050}}`,
	`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"DONE"}}`,
}

func TestCodexWatch_ReadsARollout(t *testing.T) {
	var told []toldFrame
	watch := &codexWatch{prefix: "r:", tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}}
	for _, line := range rolloutLines {
		watch.rolloutLine([]byte(line))
	}
	watch.rolloutLine([]byte("not json"))
	use := func(id, name string, input map[string]any) toldFrame {
		return toldFrame{"print-tool-use", map[string]any{"tool_use_id": id, "tool_name": name, "tool_input": input}}
	}
	result := func(id string, failed bool, why string, took int64) toldFrame {
		payload := map[string]any{"tool_use_id": id, "is_error": failed, "duration_ms": took}
		if why != "" {
			payload["error"] = why
		}
		return toldFrame{"print-tool-result", payload}
	}
	want := []toldFrame{
		{"print-text", map[string]any{"text": "I'll create note.txt, then run ls."}},
		// A patch's files in order, each a tool.
		use("r:exec-1:0", "Edit", map[string]any{"file_path": "/w/a.ts"}),
		result("r:exec-1:0", false, "", 1),
		use("r:exec-1:1", "Write", map[string]any{"file_path": "/w/note.txt"}),
		result("r:exec-1:1", false, "", 1),
		use("r:exec-2", "Bash", map[string]any{"command": "npm test"}),
		result("r:exec-2", true, "FAIL a.test.ts", 4500),
		{"print-text", map[string]any{"text": "DONE"}},
	}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("told:\n%v\nwant:\n%v", told, want)
	}
	if watch.result() != "DONE" {
		t.Fatalf("answer %q", watch.result())
	}
}

func TestArgvCommand(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"/bin/bash", "-lc", "ls -la"}, "ls -la"},
		{[]string{"zsh", "-c", "echo hi"}, "echo hi"},
		{[]string{"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"}, "Get-ChildItem"},
		{[]string{"git", "status"}, "git status"},
		{[]string{"/bin/bash", "-lc"}, "/bin/bash -lc"},
	} {
		if got := argvCommand(tc.argv); got != tc.want {
			t.Errorf("argvCommand(%q) = %q, want %q", tc.argv, got, tc.want)
		}
	}
}

func TestCodexRollout_FollowsTheSessionsRolloutOnceKnown(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	const id = "01a1b1e2-7511-7531-92ee-5984efc1790d"
	day := filepath.Join(home, "sessions", "2026", "11", "06")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(day, "rollout-2026-11-06T17-22-50-"+id+".jsonl")
	// Another session's rollout is not read.
	other := filepath.Join(day, "rollout-2026-11-06T17-00-00-01a1b1cd-0000-0000-0000-000000000000.jsonl")
	if err := os.WriteFile(other, []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("earlier\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rollout := newCodexRollout()
	// A run that goes on the session is read from where the session was.
	rollout.startAtEnd(id)
	var lines []string
	found := make(chan struct{})
	go rollout.follow(func(b []byte) { lines = append(lines, string(b)) }, func() { close(found) })
	select {
	case <-found:
	case <-time.After(5 * time.Second):
		t.Fatal("rollout not found")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("first\nlast")
	f.Close()
	if !rollout.end(5 * time.Second) {
		t.Fatal("rollout not read to its end")
	}
	if strings.Join(lines, ",") != "first,last" {
		t.Fatalf("lines %q", lines)
	}
}

func TestCodexRollout_WaitsForTheSession(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	rollout := newCodexRollout()
	if rollout.open() != nil {
		t.Fatal("opened a rollout with no session told")
	}
	rollout.know("01a1b1e2")
	rollout.know("not this one")
	if rollout.open() != nil || rollout.id != "01a1b1e2" {
		t.Fatalf("id %q", rollout.id)
	}
}
