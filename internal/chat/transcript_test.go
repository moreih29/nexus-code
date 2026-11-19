package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranscriptFindsSessionInAnyProject(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "projects", "-some-project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	content := `{"type":"user","n":1}` + "\n" + "garbage\n" + `{"type":"assistant","n":2}` + "\n"
	if err := os.WriteFile(filepath.Join(project, id+".jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	service := New()
	params, _ := json.Marshal(TranscriptParams{SessionID: id, ConfigDir: dir})
	result, err := service.Transcript(context.Background(), params)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	got := result.(TranscriptResult)
	if !got.Found || len(got.Lines) != 2 || string(got.Lines[1]) != `{"type":"assistant","n":2}` {
		t.Fatalf("transcript = %+v", got)
	}

	params, _ = json.Marshal(TranscriptParams{SessionID: "../../etc/passwd", ConfigDir: dir})
	if _, err := service.Transcript(context.Background(), params); err == nil {
		t.Fatal("Transcript took a path for a session id")
	}
}

func TestSubagentTranscriptFindsAnAgentByItsIdOrItsCall(t *testing.T) {
	dir := t.TempDir()
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	folder := filepath.Join(dir, "projects", "-some-project", id, "subagents")
	body := `{"parentUuid":null,"isSidechain":true,"agentId":"a1b2c3","type":"user","message":{"role":"user","content":"go"}}` + "\n" +
		`{"type":"api-request-blob","base":"..."}` + "\n" +
		"garbage\n" +
		`{"parentUuid":"x","isSidechain":true,"type":"assistant","message":{"content":[]}}` + "\n" +
		`{"type":"attachment","attachment":{}}` + "\n"
	writeTestFile(t, filepath.Join(folder, "agent-a1b2c3.jsonl"), body)
	writeTestFile(t, filepath.Join(folder, "agent-a1b2c3.meta.json"), `{"agentType":"Explore","toolUseId":"toolu_01"}`)
	writeTestFile(t, filepath.Join(folder, "agent-other.jsonl"), `{"type":"user","message":{}}`+"\n")
	writeTestFile(t, filepath.Join(folder, "agent-other.meta.json"), `{"agentType":"Plan","toolUseId":"toolu_02"}`)
	service := New()
	read := func(params SubagentTranscriptParams) SubagentTranscriptResult {
		t.Helper()
		raw, _ := json.Marshal(params)
		result, err := service.SubagentTranscript(context.Background(), raw)
		if err != nil {
			t.Fatalf("SubagentTranscript(%+v): %v", params, err)
		}
		return result.(SubagentTranscriptResult)
	}

	got := read(SubagentTranscriptParams{SessionID: id, AgentID: "a1b2c3", ConfigDir: dir})
	if !got.Found || len(got.Lines) != 2 {
		t.Fatalf("by agent id = %+v", got)
	}
	if typ := messageType(got.Lines[1]); typ != "assistant" {
		t.Fatalf("second line is %q", typ)
	}
	if got := read(SubagentTranscriptParams{SessionID: id, ToolUseID: "toolu_01", ConfigDir: dir}); !got.Found || len(got.Lines) != 2 {
		t.Fatalf("by call = %+v", got)
	}
	// An agent id with no file of its own is looked for by its call.
	if got := read(SubagentTranscriptParams{SessionID: id, AgentID: "gone", ToolUseID: "toolu_02", ConfigDir: dir}); !got.Found || len(got.Lines) != 1 {
		t.Fatalf("by call after the id = %+v", got)
	}
	if got := read(SubagentTranscriptParams{SessionID: id, ToolUseID: "toolu_03", ConfigDir: dir}); got.Found {
		t.Fatalf("a call with no agent = %+v", got)
	}

	for _, bad := range []SubagentTranscriptParams{
		{SessionID: "../../etc/passwd", AgentID: "a1b2c3", ConfigDir: dir},
		{SessionID: id, AgentID: "../../x", ConfigDir: dir},
		{SessionID: id, ConfigDir: dir},
	} {
		raw, _ := json.Marshal(bad)
		if _, err := service.SubagentTranscript(context.Background(), raw); err == nil {
			t.Fatalf("SubagentTranscript took %+v", bad)
		}
	}
}

func TestSessionFileFindsClaudeSessions(t *testing.T) {
	service := New()
	find := func(params SessionFileParams) SessionFileResult {
		t.Helper()
		raw, _ := json.Marshal(params)
		result, err := service.SessionFile(context.Background(), raw)
		if err != nil {
			t.Fatalf("SessionFile(%+v): %v", params, err)
		}
		return result.(SessionFileResult)
	}
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	claude := t.TempDir()
	transcript := filepath.Join(claude, "projects", "-w", id+".jsonl")
	writeTestFile(t, transcript, "{}\n")
	if got := find(SessionFileParams{SessionID: id, ConfigDir: claude}); !got.Found || got.Path != transcript {
		t.Fatalf("claude = %+v", got)
	}
	if got := find(SessionFileParams{SessionID: "1b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90", ConfigDir: claude}); got.Found {
		t.Fatalf("a session not there = %+v", got)
	}
	raw, _ := json.Marshal(SessionFileParams{SessionID: "../../etc/passwd", ConfigDir: claude})
	if _, err := service.SessionFile(context.Background(), raw); err == nil {
		t.Fatal("SessionFile took a path for a session id")
	}
}

func TestReadJSONLinesKeepsTheEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	var b strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, `{"n":%d}`+"\n", i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, err := readJSONLines(path, 50)
	if err != nil || !truncated {
		t.Fatalf("err %v, truncated %v", err, truncated)
	}
	if len(lines) == 0 || string(lines[len(lines)-1]) != `{"n":99}` {
		t.Fatalf("lines = %s", lines)
	}
	for _, line := range lines {
		if !json.Valid(line) {
			t.Fatalf("partial line %s", line)
		}
	}
}
