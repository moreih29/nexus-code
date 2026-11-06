package hookclient

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeAgentTranscript writes a session's transcript and its subagent's, as
// Claude Code keeps them, and gives the session's path.
func writeAgentTranscript(t *testing.T, agentID, content string) string {
	t.Helper()
	dir := t.TempDir()
	session := filepath.Join(dir, "s1.jsonl")
	if err := os.WriteFile(session, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "s1", "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "agent-"+agentID+".jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return session
}

func agentHookPayload(t *testing.T, fields map[string]string) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

const agentTranscript = `{"parentUuid":null,"isSidechain":true,"agentId":"a1","type":"user","uuid":"u0","message":{"role":"user","content":"Count the files."}}
{"isSidechain":true,"agentId":"a1","type":"assistant","uuid":"u1","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"text","text":"  I'll list the files first.  "}]}}
{"isSidechain":true,"agentId":"a1","type":"assistant","uuid":"u2","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}
{"isSidechain":true,"agentId":"a1","type":"user","uuid":"u3","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a\nb"}]}}
{"isSidechain":true,"agentId":"a1","type":"assistant","uuid":"u4","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"made up"}]}}
{"isSidechain":true,"agentId":"a1","type":"assistant","uuid":"u5","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"2"}]}}
{"isSidechain":true,"agentId":"a1","type":"assistant","uuid":"u6","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"text","text":"still being writ`

func TestHookAgentMessages_ReadsTheSubagentsText(t *testing.T) {
	session := writeAgentTranscript(t, "a1", agentTranscript)
	payload := agentHookPayload(t, map[string]string{"agent_id": "a1", "transcript_path": session})
	got := hookAgentMessages("pre-tool-use", payload)
	want := []agentMessage{
		{ID: "u1:0", Text: "I'll list the files first."},
		{ID: "u5:1", Text: "2"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("messages: got %+v, want %+v", got, want)
	}
}

func TestHookAgentMessages_TakesTheTranscriptTheHookTells(t *testing.T) {
	session := writeAgentTranscript(t, "a1", agentTranscript)
	path := filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents", "agent-a1.jsonl")
	payload := agentHookPayload(t, map[string]string{
		"agent_id":              "a1",
		"transcript_path":       "/nowhere/s.jsonl",
		"agent_transcript_path": path,
	})
	if got := hookAgentMessages("subagent-stop", payload); len(got) != 2 {
		t.Errorf("messages: got %+v", got)
	}
}

func TestHookAgentMessages_NoneOutsideASubagentsCall(t *testing.T) {
	session := writeAgentTranscript(t, "a1", agentTranscript)
	cases := []struct {
		name       string
		subcommand string
		fields     map[string]string
	}{
		{"the session's own call", "pre-tool-use", map[string]string{"transcript_path": session}},
		{"another hook", "permission-request", map[string]string{"agent_id": "a1", "transcript_path": session}},
		{"an id with a path in it", "pre-tool-use", map[string]string{"agent_id": "../a1", "transcript_path": session}},
		{"no transcript", "pre-tool-use", map[string]string{"agent_id": "a2", "transcript_path": session}},
	}
	for _, c := range cases {
		if got := hookAgentMessages(c.subcommand, agentHookPayload(t, c.fields)); got != nil {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
}

func TestReadAgentMessages_KeepsTheLatest(t *testing.T) {
	var b strings.Builder
	for i := range agentMessagesKept + 5 {
		fmt.Fprintf(&b, `{"uuid":"u%d","message":{"role":"assistant","content":[{"type":"text","text":"m%d"}]}}`+"\n", i, i)
	}
	session := writeAgentTranscript(t, "a1", b.String())
	got := readAgentMessages(filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents", "agent-a1.jsonl"))
	if len(got) != agentMessagesKept || got[0].Text != "m5" || got[len(got)-1].Text != fmt.Sprintf("m%d", agentMessagesKept+4) {
		t.Errorf("messages: got %d, first %+v", len(got), got[0])
	}
}

func TestReadAgentMessages_ReadsTheTail(t *testing.T) {
	// A transcript longer than what is read: its latest lines are, not the
	// line cut where the read starts.
	big := strings.Repeat("x", int(agentTranscriptTail))
	content := `{"uuid":"old","message":{"role":"assistant","content":[{"type":"text","text":"` + big + `"}]}}` + "\n" +
		`{"uuid":"new","message":{"role":"assistant","content":[{"type":"text","text":"latest"}]}}` + "\n"
	session := writeAgentTranscript(t, "a1", content)
	got := readAgentMessages(filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents", "agent-a1.jsonl"))
	want := []agentMessage{{ID: "new:0", Text: "latest"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("messages: got %+v, want %+v", got, want)
	}
}
