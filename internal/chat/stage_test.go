package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestFailedStagedCopyKeepsExistingRollout covers a source that fails during
// reading after its open succeeds. The old rollout remains usable by forks.
func TestFailedStagedCopyKeepsExistingRollout(t *testing.T) {
	dir := t.TempDir()
	to := filepath.Join(dir, "copied.jsonl")
	const old = "{\"type\":\"session_meta\"}\n"
	writeTestFile(t, to, old)
	// os.Open can open a directory, but it cannot provide rollout bytes.
	if err := copyFile(t.TempDir(), to); err == nil {
		t.Fatal("copying from a directory succeeded")
	}
	if got, err := os.ReadFile(to); err != nil || string(got) != old {
		t.Fatalf("existing rollout changed: %q, %v", got, err)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 1 {
		t.Fatalf("failed copy left temporary files: %v, %v", entries, err)
	}
}

func TestStageThreadPutsACopyWhereTheProfileFindsIt(t *testing.T) {
	service := New()
	stage := func(params StageThreadParams) StageThreadResult {
		t.Helper()
		raw, _ := json.Marshal(params)
		result, err := service.StageThread(context.Background(), raw)
		if err != nil {
			t.Fatalf("StageThread(%+v): %v", params, err)
		}
		return result.(StageThreadResult)
	}
	id := "01a1c494-518d-7651-938d-00031c0ec9fb"
	name := "rollout-2026-11-10T17-30-17-" + id + ".jsonl"
	from, to := t.TempDir(), t.TempDir()
	writeTestFile(t, filepath.Join(from, "sessions", "2026", "11", "10", name), `{"type":"session_meta"}`+"\n")
	staged := filepath.Join(to, "sessions", stagedDir, name)

	if got := stage(StageThreadParams{ThreadID: id, From: from, To: to}); !got.Found {
		t.Fatalf("stage = %+v", got)
	}
	if body, err := os.ReadFile(staged); err != nil || string(body) != `{"type":"session_meta"}`+"\n" {
		t.Fatalf("staged copy = %q, %v", body, err)
	}
	// The copy is not one of the profile's own threads.
	if got := rolloutPath(to, id); got != "" {
		t.Fatalf("rolloutPath took the staged copy: %s", got)
	}
	// The copy stays once the thread is forked: the fork reads its history
	// from it each time it resumes.
	if got := stage(StageThreadParams{ThreadID: id, From: from, To: to}); !got.Found {
		t.Fatalf("stage again = %+v", got)
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatalf("the staged copy went: %v", err)
	}

	// An archived thread is staged too: the fork unarchives nothing.
	if err := os.RemoveAll(filepath.Join(from, "sessions")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(to, "sessions")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(from, "archived_sessions", name), "{}\n")
	if got := stage(StageThreadParams{ThreadID: id, From: from, To: to}); !got.Found {
		t.Fatalf("archived stage = %+v", got)
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatalf("archived thread not staged: %v", err)
	}

	// A copy longer than the thread is not cut back: a fork made from it
	// reads it to where it was forked.
	writeTestFile(t, staged, "{}\n{}\n")
	stage(StageThreadParams{ThreadID: id, From: from, To: to})
	if body, _ := os.ReadFile(staged); string(body) != "{}\n{}\n" {
		t.Fatalf("a longer copy was cut back: %q", body)
	}

	// Profiles of one folder need no copy; a thread not there is not found.
	if got := stage(StageThreadParams{ThreadID: id, From: from, To: from}); !got.Found {
		t.Fatalf("same folder = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(from, "sessions", stagedDir)); !os.IsNotExist(err) {
		t.Fatalf("a copy was staged in the folder that keeps the thread: %v", err)
	}
	if got := stage(StageThreadParams{ThreadID: "1b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90", From: from, To: to}); got.Found {
		t.Fatalf("a thread not there = %+v", got)
	}
	raw, _ := json.Marshal(StageThreadParams{ThreadID: "../../etc", From: from, To: to})
	if _, err := service.StageThread(context.Background(), raw); err == nil {
		t.Fatal("StageThread took a path for a thread id")
	}
}

func TestStageThreadBringsTheThreadsItWasForkedFrom(t *testing.T) {
	service := New()
	meta := func(id, parent string) string {
		payload := map[string]string{"id": id}
		if parent != "" {
			payload["forked_from_id"] = parent
		}
		line, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": payload})
		return string(line) + "\n"
	}
	rollout := func(id string) string { return "rollout-2026-11-11T10-00-00-" + id + ".jsonl" }
	first := "01a1c8c5-b25a-7e12-808a-07e9fcbe1a9e"
	second := "01a1c8ca-8ced-7802-8567-1af7c18bc127"
	third := "01a1c9d0-1111-7222-8333-444455556666"
	from, to := t.TempDir(), t.TempDir()
	// The profile keeps the first thread, a copy of the second it forked
	// from another profile, and the third, forked from that copy in turn.
	writeTestFile(t, filepath.Join(from, "archived_sessions", rollout(first)), meta(first, ""))
	writeTestFile(t, filepath.Join(from, "sessions", stagedDir, rollout(second)), meta(second, first))
	writeTestFile(t, filepath.Join(from, "sessions", "2026", "11", "11", rollout(third)), meta(third, second))

	raw, _ := json.Marshal(StageThreadParams{ThreadID: third, From: from, To: to})
	if result, err := service.StageThread(context.Background(), raw); err != nil || !result.(StageThreadResult).Found {
		t.Fatalf("StageThread = %+v, %v", result, err)
	}
	for _, id := range []string{first, second, third} {
		if _, err := os.Stat(filepath.Join(to, "sessions", stagedDir, rollout(id))); err != nil {
			t.Fatalf("%s not staged: %v", id, err)
		}
	}

	// A thread the profile keeps itself is not staged, nor those before it.
	other := t.TempDir()
	writeTestFile(t, filepath.Join(other, "sessions", "2026", "11", "11", rollout(second)), meta(second, first))
	raw, _ = json.Marshal(StageThreadParams{ThreadID: third, From: from, To: other})
	if _, err := service.StageThread(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(other, "sessions", stagedDir))
	if len(entries) != 1 || entries[0].Name() != rollout(third) {
		t.Fatalf("staged in a profile that keeps the second thread: %v", entries)
	}
}
