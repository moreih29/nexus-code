package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
)

const (
	claudeCwd     = "/home/me/app"
	claudeProject = "-home-me-app"
)

func claudeCall[P any](t *testing.T, method func(context.Context, json.RawMessage) (any, error), params P) any {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := method(context.Background(), raw)
	if err != nil {
		t.Fatalf("%T: %v", params, err)
	}
	return result
}

func claudeSessionSeenBy(t *testing.T, config string) []string {
	t.Helper()
	service := New()
	var seen []string
	if claudeCall(t, service.Transcript, TranscriptParams{SessionID: runSession, ConfigDir: config}).(TranscriptResult).Found {
		seen = append(seen, "transcript")
	}
	if claudeCall(t, service.SessionFile, SessionFileParams{SessionID: runSession, ConfigDir: config}).(SessionFileResult).Found {
		seen = append(seen, "sessionFile")
	}
	if claudeCall(t, service.RunTranscript, RunTranscriptParams{SessionID: runSession, ConfigDir: config}).(RunTranscriptResult).Found {
		seen = append(seen, "runTranscript")
	}
	if claudeCall(t, service.TranscriptPage, transcriptPageParams{TranscriptParams: TranscriptParams{SessionID: runSession, ConfigDir: config}}).(transcriptPage).Found {
		seen = append(seen, "transcriptPage")
	}
	for _, session := range claudeCall(t, service.Sessions, SessionsParams{Cwd: claudeCwd, ConfigDir: config}).(SessionsResult).Sessions {
		if session.SessionID == runSession {
			seen = append(seen, "sessions")
		}
	}
	return seen
}

func claudeSubagentSeenBy(t *testing.T, config string) []string {
	t.Helper()
	service := New()
	var seen []string
	for _, params := range []SubagentTranscriptParams{
		{SessionID: runSession, AgentID: "a1", ConfigDir: config},
		{SessionID: runSession, ToolUseID: "tu-1", ConfigDir: config},
	} {
		if claudeCall(t, service.SubagentTranscript, params).(SubagentTranscriptResult).Found {
			seen = append(seen, "subagent:"+params.AgentID+params.ToolUseID)
		}
	}
	return seen
}

func writeClaudeSession(t *testing.T, projects string) string {
	t.Helper()
	folder := filepath.Join(projects, claudeProject)
	path := filepath.Join(folder, runSession+".jsonl")
	writeText(t, path, `{"type":"user","message":{"content":"hello"}}`+"\n")
	return path
}

func writeClaudeSubagent(t *testing.T, folder string) {
	t.Helper()
	writeText(t, filepath.Join(folder, "agent-a1.jsonl"), `{"type":"user","message":{"content":"hi"}}`+"\n")
	writeText(t, filepath.Join(folder, "agent-a1.meta.json"), `{"toolUseId":"tu-1"}`)
}

func writeText(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func deletedBy(t *testing.T, config string) bool {
	t.Helper()
	return claudeCall(t, New().DeleteSession, DeleteSessionParams{Cwd: claudeCwd, SessionID: runSession, ConfigDir: config}).(DeleteSessionResult).Deleted
}

var everyClaudeRead = []string{"transcript", "sessionFile", "runTranscript", "transcriptPage", "sessions"}

func sameReads(got, want []string) bool {
	sort.Strings(got)
	sorted := append([]string{}, want...)
	sort.Strings(sorted)
	return strings.Join(got, ",") == strings.Join(sorted, ",")
}

func claudeLookupsFollowNoLink(t *testing.T, fileLink, dirLink func(t *testing.T, target, link string)) {
	t.Run("a linked config folder and projects folder are read", func(t *testing.T) {
		home := t.TempDir()
		writeClaudeSession(t, filepath.Join(home, "projects"))
		writeClaudeSubagent(t, filepath.Join(home, "projects", claudeProject, runSession, "subagents"))
		config := filepath.Join(t.TempDir(), "claude")
		dirLink(t, home, config)
		if got := claudeSessionSeenBy(t, config); !sameReads(got, everyClaudeRead) {
			t.Fatalf("through a linked config folder: %v", got)
		}
		if got := claudeSubagentSeenBy(t, config); len(got) != 2 {
			t.Fatalf("subagent through a linked config folder: %v", got)
		}

		moved := t.TempDir()
		writeClaudeSession(t, moved)
		writeClaudeSubagent(t, filepath.Join(moved, claudeProject, runSession, "subagents"))
		config = t.TempDir()
		dirLink(t, moved, filepath.Join(config, "projects"))
		if got := claudeSessionSeenBy(t, config); !sameReads(got, everyClaudeRead) {
			t.Fatalf("through a linked projects folder: %v", got)
		}
		if got := claudeSubagentSeenBy(t, config); len(got) != 2 {
			t.Fatalf("subagent through a linked projects folder: %v", got)
		}
		if !deletedBy(t, config) {
			t.Fatal("a session in a linked projects folder was not deleted")
		}
	})

	t.Run("a linked project folder is not read", func(t *testing.T) {
		outside := t.TempDir()
		secret := writeClaudeSession(t, outside)
		writeClaudeSubagent(t, filepath.Join(outside, claudeProject, runSession, "subagents"))
		config := t.TempDir()
		mkdir(t, filepath.Join(config, "projects"))
		dirLink(t, filepath.Dir(secret), filepath.Join(config, "projects", claudeProject))
		if got := claudeSessionSeenBy(t, config); len(got) != 0 {
			t.Fatalf("read through a linked project folder: %v", got)
		}
		if got := claudeSubagentSeenBy(t, config); len(got) != 0 {
			t.Fatalf("subagent read through a linked project folder: %v", got)
		}
		if deletedBy(t, config) {
			t.Fatal("deleted through a linked project folder")
		}
		if _, err := os.Stat(secret); err != nil {
			t.Fatalf("the linked folder's session is gone: %v", err)
		}
	})

	t.Run("a linked session file is not read", func(t *testing.T) {
		secret := writeClaudeSession(t, t.TempDir())
		config := t.TempDir()
		mkdir(t, filepath.Join(config, "projects", claudeProject))
		fileLink(t, secret, filepath.Join(config, "projects", claudeProject, runSession+".jsonl"))
		if got := claudeSessionSeenBy(t, config); len(got) != 0 {
			t.Fatalf("read through a linked session file: %v", got)
		}
		if deletedBy(t, config) {
			t.Fatal("deleted through a linked session file")
		}
		if _, err := os.Stat(secret); err != nil {
			t.Fatalf("the linked session is gone: %v", err)
		}
	})

	t.Run("linked subagent folders and files are not read", func(t *testing.T) {
		outside := t.TempDir()
		writeClaudeSubagent(t, filepath.Join(outside, "subagents"))

		sessionLink := t.TempDir()
		mkdir(t, filepath.Join(sessionLink, "projects", claudeProject))
		dirLink(t, outside, filepath.Join(sessionLink, "projects", claudeProject, runSession))

		agentsLink := t.TempDir()
		mkdir(t, filepath.Join(agentsLink, "projects", claudeProject, runSession))
		dirLink(t, filepath.Join(outside, "subagents"), filepath.Join(agentsLink, "projects", claudeProject, runSession, "subagents"))

		filesLink := t.TempDir()
		agents := filepath.Join(filesLink, "projects", claudeProject, runSession, "subagents")
		mkdir(t, agents)
		fileLink(t, filepath.Join(outside, "subagents", "agent-a1.jsonl"), filepath.Join(agents, "agent-a1.jsonl"))
		fileLink(t, filepath.Join(outside, "subagents", "agent-a1.meta.json"), filepath.Join(agents, "agent-a1.meta.json"))

		for name, config := range map[string]string{"session folder": sessionLink, "subagents folder": agentsLink, "files": filesLink} {
			if got := claudeSubagentSeenBy(t, config); len(got) != 0 {
				t.Fatalf("read through a linked %s: %v", name, got)
			}
		}

		metaOnly := t.TempDir()
		agents = filepath.Join(metaOnly, "projects", claudeProject, runSession, "subagents")
		writeText(t, filepath.Join(agents, "agent-a1.jsonl"), `{"type":"user","message":{"content":"hi"}}`+"\n")
		fileLink(t, filepath.Join(outside, "subagents", "agent-a1.meta.json"), filepath.Join(agents, "agent-a1.meta.json"))
		if got := claudeSubagentSeenBy(t, metaOnly); !sameReads(got, []string{"subagent:a1"}) {
			t.Fatalf("a linked meta file named the call: %v", got)
		}
	})
}

func TestClaudeLookupsFollowNoLink(t *testing.T) {
	claudeLookupsFollowNoLink(t, symlinkOrSkip, symlinkOrSkip)
}

func TestClaudeLookupsTakeNoPathAsAnID(t *testing.T) {
	config := t.TempDir()
	writeText(t, filepath.Join(config, "secret.jsonl"), `{"type":"user","message":{"content":"x"}}`+"\n")
	writeText(t, filepath.Join(config, "projects", "p", "subagents", "agent-x.jsonl"), "{}\n")
	writeText(t, filepath.Join(config, "projects", "p", "s", "subagents", "agent-..jsonl"), "{}\n")
	for _, id := range []string{"../../secret", `..\..\secret`, "..", "/etc/passwd", "", "a/b/c/d/e/f"} {
		if path, _ := claudefiles.FindSession(config, id); path != "" {
			t.Fatalf("session id %q found %s", id, path)
		}
		if path, _ := findSubagent(config, id, "x", ""); path != "" {
			t.Fatalf("session id %q found subagent %s", id, path)
		}
	}
	for _, id := range []string{"../../../p/subagents/x", `..\x`, ".", ""} {
		if path, _ := findSubagent(config, runSession, id, ""); path != "" {
			t.Fatalf("agent id %q found %s", id, path)
		}
	}
	service := New()
	for _, call := range []struct {
		method func(context.Context, json.RawMessage) (any, error)
		params any
	}{
		{service.Transcript, TranscriptParams{SessionID: "../secret", ConfigDir: config}},
		{service.SessionFile, SessionFileParams{SessionID: "../secret", ConfigDir: config}},
		{service.RunTranscript, RunTranscriptParams{SessionID: "../secret", ConfigDir: config}},
		{service.SubagentTranscript, SubagentTranscriptParams{SessionID: runSession, AgentID: "../x", ConfigDir: config}},
		{service.DeleteSession, DeleteSessionParams{Cwd: claudeCwd, SessionID: "../secret", ConfigDir: config}},
	} {
		raw, _ := json.Marshal(call.params)
		if _, err := call.method(context.Background(), raw); err == nil {
			t.Fatalf("%T took a path as an id", call.params)
		}
	}
}

func TestClaudeLookupsNeedAProjectsFolder(t *testing.T) {
	config := t.TempDir()
	writeText(t, filepath.Join(config, "projects"), "not a folder")
	if path, _ := claudefiles.FindSession(config, runSession); path != "" {
		t.Fatalf("found %s without a projects folder", path)
	}
	if path, _ := claudefiles.FindSession("", runSession); path != "" {
		t.Fatalf("found %s without a config folder", path)
	}
}

func TestClaudeLookupsTakeTheNewestSession(t *testing.T) {
	config := t.TempDir()
	older := writeClaudeSession(t, filepath.Join(config, "projects"))
	newer := filepath.Join(config, "projects", "other", runSession+".jsonl")
	writeText(t, newer, "{}\n")
	past := mustStat(t, newer).ModTime().Add(-3600e9)
	if err := os.Chtimes(older, past, past); err != nil {
		t.Fatal(err)
	}
	if path, info := claudefiles.FindSession(config, runSession); path != newer || !os.SameFile(info, mustStat(t, newer)) {
		t.Fatalf("found %s, not the newest %s", path, newer)
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}
