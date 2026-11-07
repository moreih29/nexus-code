package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeSession writes a transcript of `lines` in `project`, modified at `at`.
func writeSession(t *testing.T, project, id string, at time.Time, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(project, id+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func sessionsOf(t *testing.T, config, cwd string, limit int) []ClaudeSession {
	t.Helper()
	params, _ := json.Marshal(SessionsParams{Cwd: cwd, ConfigDir: config, Limit: limit})
	result, err := New().Sessions(context.Background(), params)
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	return result.(SessionsResult).Sessions
}

func TestSessionsListsAFoldersSessionsNewestFirst(t *testing.T) {
	config := t.TempDir()
	cwd := "/home/me/my_app"
	project := filepath.Join(config, "projects", "-home-me-my-app")
	now := time.Now().Truncate(time.Second)
	writeSession(t, project, "11111111-1111-4111-8111-111111111111", now.Add(-3*time.Hour),
		`{"type":"queue-operation","operation":"enqueue"}`,
		`{"type":"user","timestamp":"2026-11-01T10:00:00.000Z","isMeta":true,"message":{"content":"<system-reminder>x</system-reminder>"}}`,
		`{"type":"user","timestamp":"2026-11-01T10:00:01.000Z","message":{"content":"Fix the\n  build"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]},"gitBranch":"main"}`,
	)
	// Renamed, and asked again since: its title is the one it was given.
	writeSession(t, project, "22222222-2222-4222-8222-222222222222", now.Add(-time.Hour),
		`{"type":"user","timestamp":"2026-11-02T10:00:00.000Z","message":{"content":[{"type":"text","text":"Write tests"}]}}`,
		`{"type":"custom-title","customTitle":"Old name","sessionId":"22222222-2222-4222-8222-222222222222"}`,
		`{"type":"custom-title","customTitle":"Test plan","sessionId":"22222222-2222-4222-8222-222222222222"}`,
		`{"type":"last-prompt","lastPrompt":"And the docs","sessionId":"22222222-2222-4222-8222-222222222222"}`,
		`{"type":"assistant","gitBranch":"feat/tests"}`,
	)
	// Asked again: its title is the last prompt.
	writeSession(t, project, "33333333-3333-4333-8333-333333333333", now.Add(-2*time.Hour),
		`{"type":"user","message":{"content":"First ask"}}`,
		`{"type":"last-prompt","lastPrompt":"Second ask"}`,
		`{"type":"assistant","gitBranch":"HEAD"}`,
	)
	// Only a command: named by it.
	writeSession(t, project, "44444444-4444-4444-8444-444444444444", now.Add(-4*time.Hour),
		`{"type":"user","message":{"content":"<command-name>/context</command-name>\n<command-args></command-args>"}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}`,
	)
	// A subagent's, and one with nothing to show: left out.
	writeSession(t, project, "55555555-5555-4555-8555-555555555555", now,
		`{"type":"user","isSidechain":true,"message":{"content":"Sub task"}}`,
	)
	writeSession(t, project, "66666666-6666-4666-8666-666666666666", now,
		`{"type":"queue-operation","operation":"enqueue"}`,
	)
	// Another folder's.
	writeSession(t, filepath.Join(config, "projects", "-home-me-other"), "77777777-7777-4777-8777-777777777777", now,
		`{"type":"user","message":{"content":"Elsewhere"}}`,
	)
	if err := os.WriteFile(filepath.Join(project, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := sessionsOf(t, config, cwd, 0)
	var titles []string
	for _, s := range got {
		titles = append(titles, s.Title)
	}
	if strings.Join(titles, "|") != "Test plan|Second ask|Fix the build|/context" {
		t.Fatalf("titles = %q", titles)
	}
	first := got[0]
	if first.SessionID != "22222222-2222-4222-8222-222222222222" ||
		first.CustomTitle != "Test plan" ||
		first.FirstPrompt != "Write tests" ||
		first.GitBranch != "feat/tests" ||
		first.LastModified != now.Add(-time.Hour).UnixMilli() ||
		first.CreatedAt != time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC).UnixMilli() ||
		first.Size == 0 {
		t.Fatalf("first = %+v", first)
	}
	if got[2].FirstPrompt != "Fix the build" || got[2].GitBranch != "main" || got[2].CustomTitle != "" {
		t.Fatalf("third = %+v", got[2])
	}

	if got[1].GitBranch != "" {
		t.Fatalf("a branch of HEAD = %q", got[1].GitBranch)
	}
	if got := sessionsOf(t, config, cwd, 2); len(got) != 2 || got[1].Title != "Second ask" {
		t.Fatalf("limited = %+v", got)
	}
	if got := sessionsOf(t, config, "/nowhere", 0); len(got) != 0 {
		t.Fatalf("a folder with none = %+v", got)
	}
}

func TestSessionsReadsTheEndsOfALongTranscript(t *testing.T) {
	config := t.TempDir()
	project := filepath.Join(config, "projects", "-w")
	filler := `{"type":"assistant","message":{"content":[{"type":"text","text":"` + strings.Repeat("x", 1000) + `"}]}}`
	lines := []string{
		`{"type":"user","message":{"content":"Start"}}`,
		`{"type":"custom-title","customTitle":"Named early"}`,
	}
	for range 300 {
		lines = append(lines, filler)
	}
	writeSession(t, project, "88888888-8888-4888-8888-888888888888", time.Now(), lines...)
	got := sessionsOf(t, config, "/w", 0)
	if len(got) != 1 || got[0].Title != "Named early" || got[0].FirstPrompt != "Start" {
		t.Fatalf("the title from the start = %+v", got)
	}

	lines = append(lines, `{"type":"custom-title","customTitle":"Named late"}`)
	writeSession(t, project, "88888888-8888-4888-8888-888888888888", time.Now(), lines...)
	if got := sessionsOf(t, config, "/w", 0); got[0].Title != "Named late" {
		t.Fatalf("the title from the end = %+v", got)
	}
}

func TestSessionsFindsAProjectWhoseNameWasCut(t *testing.T) {
	config := t.TempDir()
	cwd := "/" + strings.Repeat("a", 250)
	name := "-" + strings.Repeat("a", projectNameMax-1)
	writeSession(t, filepath.Join(config, "projects", name+"-1x2y3z"), "99999999-9999-4999-8999-999999999999", time.Now(),
		`{"type":"user","message":{"content":"Deep"}}`,
	)
	if got := sessionsOf(t, config, cwd, 0); len(got) != 1 || got[0].Title != "Deep" {
		t.Fatalf("sessions = %+v", got)
	}
}

func TestSessionsTitleIsOneLineAndCut(t *testing.T) {
	long := strings.Repeat("가", sessionTextMax+10)
	if got := oneLine("a\n\tb  c"); got != "a b c" {
		t.Fatalf("oneLine = %q", got)
	}
	if got := []rune(oneLine(long)); len(got) != sessionTextMax || got[len(got)-1] != '…' {
		t.Fatalf("cut = %d runes", len(got))
	}
}
