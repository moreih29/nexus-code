package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
)

func runTranscriptRead(t *testing.T, service *Service, dir, id string, from *int64) RunTranscriptResult {
	t.Helper()
	params, _ := json.Marshal(RunTranscriptParams{SessionID: id, ConfigDir: dir, From: from})
	result, err := service.RunTranscript(context.Background(), params)
	if err != nil {
		t.Fatalf("RunTranscript: %v", err)
	}
	return result.(RunTranscriptResult)
}

func lineTexts(lines []json.RawMessage) string {
	texts := make([]string, len(lines))
	for i, line := range lines {
		texts[i] = string(line)
	}
	return strings.Join(texts, ",")
}

func TestRunTranscriptReadsOnFromWhereItEnded(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "projects", "-repo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	path := filepath.Join(project, id+".jsonl")
	service := New()

	if got := runTranscriptRead(t, service, dir, id, nil); got.Found || len(got.Lines) != 0 {
		t.Fatalf("before the file: %+v", got)
	}

	if err := os.WriteFile(path, []byte(`{"n":1}`+"\n"+"junk\n"+`{"n":2`), 0o644); err != nil {
		t.Fatal(err)
	}
	first := runTranscriptRead(t, service, dir, id, nil)
	if !first.Found || lineTexts(first.Lines) != `{"n":1}` || first.Next != int64(len(`{"n":1}`+"\n"+"junk\n")) ||
		first.Reset || first.Truncated {
		t.Fatalf("first = %+v", first)
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString("}\n" + `{"n":3}` + "\n")
	_ = file.Close()
	next := runTranscriptRead(t, service, dir, id, &first.Next)
	if lineTexts(next.Lines) != `{"n":2},{"n":3}` || next.Reset {
		t.Fatalf("next = %+v", next)
	}
	same := runTranscriptRead(t, service, dir, id, &next.Next)
	if len(same.Lines) != 0 || same.Next != next.Next {
		t.Fatalf("nothing new = %+v", same)
	}

	if err := os.WriteFile(path, []byte(`{"n":9}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	again := runTranscriptRead(t, service, dir, id, &next.Next)
	if !again.Reset || lineTexts(again.Lines) != `{"n":9}` || again.Next != 8 {
		t.Fatalf("again = %+v", again)
	}

	params, _ := json.Marshal(RunTranscriptParams{SessionID: "../../etc/passwd", ConfigDir: dir})
	if _, err := service.RunTranscript(context.Background(), params); err == nil {
		t.Fatal("RunTranscript took a path for a session id")
	}
	negative := int64(-1)
	params, _ = json.Marshal(RunTranscriptParams{SessionID: id, ConfigDir: dir, From: &negative})
	if _, err := service.RunTranscript(context.Background(), params); err == nil {
		t.Fatal("RunTranscript took a negative place")
	}
}

func TestRunTranscriptKeepsTheLastLinesPastTheCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.jsonl")
	content := `{"n":1}` + "\n" + `{"n":2}` + "\n" + `{"n":3}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readRunTranscript(path, nil, nil, 12)
	if err != nil || !got.Truncated || lineTexts(got.Lines) != `{"n":3}` || got.Next != int64(len(content)) {
		t.Fatalf("cut inside = %+v, %v", got, err)
	}
	got, err = readRunTranscript(path, nil, nil, 16)
	if err != nil || !got.Truncated || lineTexts(got.Lines) != `{"n":2},{"n":3}` {
		t.Fatalf("cut on a start = %+v, %v", got, err)
	}
	from := int64(0)
	got, err = readRunTranscript(path, nil, &from, 12)
	if err != nil || !got.Truncated || got.Reset || lineTexts(got.Lines) != `{"n":3}` {
		t.Fatalf("from = %+v, %v", got, err)
	}
}

const runSession = "0123abcd-run-session"

func writeRunTranscript(t *testing.T, dir, project, text string) string {
	t.Helper()
	folder := filepath.Join(dir, "projects", project)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, runSession+".jsonl")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("no symlinks here: %v", err)
		}
		t.Fatal(err)
	}
}

func TestRunTranscriptFollowsNoLinkOutOfTheRunsFolder(t *testing.T) {
	service := New()
	outside := t.TempDir()
	secret := writeRunTranscript(t, outside, "elsewhere", `{"secret":1}`+"\n")

	fileLink := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fileLink, "projects", "p"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, secret, filepath.Join(fileLink, "projects", "p", runSession+".jsonl"))
	if got := runTranscriptRead(t, service, fileLink, runSession, nil); got.Found {
		t.Fatalf("read through a linked file: %s", lineTexts(got.Lines))
	}

	folderLink := t.TempDir()
	if err := os.MkdirAll(filepath.Join(folderLink, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, filepath.Dir(secret), filepath.Join(folderLink, "projects", "p"))
	if got := runTranscriptRead(t, service, folderLink, runSession, nil); got.Found {
		t.Fatalf("read through a linked project folder: %s", lineTexts(got.Lines))
	}

	moved := t.TempDir()
	writeRunTranscript(t, moved, "p", `{"moved":1}`+"\n")
	symlinkOrSkip(t, secret, filepath.Join(moved, "projects", "p", "other-session.jsonl"))
	symlinkOrSkip(t, filepath.Dir(secret), filepath.Join(moved, "projects", "q"))
	projectsLink := t.TempDir()
	symlinkOrSkip(t, filepath.Join(moved, "projects"), filepath.Join(projectsLink, "projects"))
	if got := runTranscriptRead(t, service, projectsLink, runSession, nil); !got.Found || lineTexts(got.Lines) != `{"moved":1}` {
		t.Fatalf("a linked projects folder was not read: %+v", got)
	}
	if got := runTranscriptRead(t, service, projectsLink, "other-session", nil); got.Found {
		t.Fatalf("read through a linked file in a linked projects folder: %s", lineTexts(got.Lines))
	}

	home := t.TempDir()
	writeRunTranscript(t, home, "p", `{"mine":1}`+"\n")
	linked := filepath.Join(t.TempDir(), "claude")
	symlinkOrSkip(t, home, linked)
	if got := runTranscriptRead(t, service, linked, runSession, nil); !got.Found || lineTexts(got.Lines) != `{"mine":1}` {
		t.Fatalf("a linked config folder was not read: %+v", got)
	}
}

func TestRunTranscriptReadsOnlyTheFileThatWasFound(t *testing.T) {
	dir := t.TempDir()
	path := writeRunTranscript(t, dir, "p", `{"a":1}`+"\n")
	other := writeRunTranscript(t, t.TempDir(), "p", `{"b":2}`+"\n")
	want, err := os.Lstat(other)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readRunTranscript(path, want, nil, 1024); err == nil {
		t.Fatal("read a file other than the one found")
	}
}

func TestTranscriptFoldersAreNamesNotPatterns(t *testing.T) {
	service := New()
	parent := t.TempDir()
	for _, name := range []string{"cfg[1]", "cfg*"} {
		if runtime.GOOS == "windows" && strings.Contains(name, "*") {
			continue
		}
		dir := filepath.Join(parent, name)
		writeRunTranscript(t, dir, "p", `{"in":"`+name+`"}`+"\n")
		if got := runTranscriptRead(t, service, dir, runSession, nil); !got.Found || !strings.Contains(lineTexts(got.Lines), name) {
			t.Fatalf("%s: not read: %+v", name, got)
		}
		if got, _ := claudefiles.FindSession(dir, runSession); got == "" {
			t.Fatalf("%s: chat.transcript's path not found", name)
		}
		agents := filepath.Join(dir, "projects", "p", runSession, "subagents")
		if err := os.MkdirAll(agents, 0o755); err != nil {
			t.Fatal(err)
		}
		for file, text := range map[string]string{"agent-a1.jsonl": "{}\n", "agent-a1.meta.json": `{"toolUseId":"tu-1"}`} {
			if err := os.WriteFile(filepath.Join(agents, file), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got, _ := findSubagent(dir, runSession, "a1", ""); got == "" {
			t.Fatalf("%s: a subagent's path not found by its id", name)
		}
	}
	if runtime.GOOS != "windows" {
		sibling := filepath.Join(parent, "cfgX")
		writeRunTranscript(t, sibling, "p", `{"in":"sibling"}`+"\n")
		if err := os.RemoveAll(filepath.Join(parent, "cfg*", "projects")); err != nil {
			t.Fatal(err)
		}
		if got, _ := claudefiles.FindSession(filepath.Join(parent, "cfg*"), runSession); got != "" {
			t.Fatalf("a pattern reached a sibling: %s", got)
		}
		if got := runTranscriptRead(t, service, filepath.Join(parent, "cfg*"), runSession, nil); got.Found {
			t.Fatal("a pattern reached a sibling's run")
		}
	}
	dir := t.TempDir()
	writeRunTranscript(t, dir, "-repo-[draft]", `{"p":1}`+"\n")
	if got := runTranscriptRead(t, service, dir, runSession, nil); !got.Found {
		t.Fatal("a project folder with brackets was not found")
	}
}

func TestRunTranscriptErrorNamesNoPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes do not refuse a read there")
	}
	if os.Geteuid() == 0 {
		t.Skip("root reads any file")
	}
	service := New()
	dir := t.TempDir()
	path := writeRunTranscript(t, dir, "p", `{"a":1}`+"\n")
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(RunTranscriptParams{SessionID: runSession, ConfigDir: dir})
	_, err := service.RunTranscript(context.Background(), params)
	if err == nil {
		t.Fatal("an unreadable transcript was read")
	}
	if strings.Contains(err.Error(), dir) || strings.Contains(err.Error(), "projects") {
		t.Fatalf("the error names the path: %v", err)
	}
}
