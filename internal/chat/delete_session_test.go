package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func deleteSession(t *testing.T, config, cwd, id string) (DeleteSessionResult, error) {
	t.Helper()
	params, _ := json.Marshal(DeleteSessionParams{Cwd: cwd, SessionID: id, ConfigDir: config})
	result, err := New().DeleteSession(context.Background(), params)
	if err != nil {
		return DeleteSessionResult{}, err
	}
	return result.(DeleteSessionResult), nil
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestDeleteSessionRemovesItsTranscriptAndWhatItKept(t *testing.T) {
	config := t.TempDir()
	cwd := "/home/me/my_app"
	project := filepath.Join(config, "projects", "-home-me-my-app")
	gone := "11111111-1111-4111-8111-111111111111"
	kept := "22222222-2222-4222-8222-222222222222"
	now := time.Now()
	writeSession(t, project, gone, now, `{"type":"user","message":{"content":"Delete me"}}`)
	writeSession(t, project, kept, now, `{"type":"user","message":{"content":"Keep me"}}`)
	owned := []string{
		filepath.Join(project, gone, "subagents", "agent-1.jsonl"),
		filepath.Join(project, gone, "tool-results", "r.txt"),
		filepath.Join(config, "file-history", gone, "f@v1"),
		filepath.Join(config, "session-env", gone, "env"),
		filepath.Join(config, "todos", gone+"-agent-"+gone+".json"),
		filepath.Join(config, "debug", gone+".txt"),
	}
	others := []string{
		filepath.Join(project, kept, "subagents", "agent-1.jsonl"),
		filepath.Join(config, "file-history", kept, "f@v1"),
		filepath.Join(config, "todos", kept+"-agent-"+kept+".json"),
	}
	for _, path := range append(append([]string{}, owned...), others...) {
		writeFile(t, path)
	}

	result, err := deleteSession(t, config, cwd, gone)
	if err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if !result.Deleted {
		t.Fatal("Deleted = false, want true")
	}
	if exists(filepath.Join(project, gone+".jsonl")) {
		t.Error("its transcript is still there")
	}
	for _, path := range owned {
		if exists(path) {
			t.Errorf("%s is still there", path)
		}
	}
	if exists(filepath.Join(project, gone)) || exists(filepath.Join(config, "file-history", gone)) {
		t.Error("a directory named by its id is still there")
	}
	for _, path := range append(others, filepath.Join(project, kept+".jsonl")) {
		if !exists(path) {
			t.Errorf("%s of another session was deleted", path)
		}
	}
	sessions := sessionsOf(t, config, cwd, 0)
	if len(sessions) != 1 || sessions[0].SessionID != kept {
		t.Fatalf("the list after = %+v, want only %s", sessions, kept)
	}
}

func TestDeleteSessionLeavesAnotherFoldersSessionAlone(t *testing.T) {
	config := t.TempDir()
	id := "11111111-1111-4111-8111-111111111111"
	other := filepath.Join(config, "projects", "-home-me-other")
	writeSession(t, other, id, time.Now(), `{"type":"user","message":{"content":"Elsewhere"}}`)
	writeFile(t, filepath.Join(config, "file-history", id, "f@v1"))

	result, err := deleteSession(t, config, "/home/me/my_app", id)
	if err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if result.Deleted {
		t.Fatal("Deleted = true for a session of another folder")
	}
	if !exists(filepath.Join(other, id+".jsonl")) || !exists(filepath.Join(config, "file-history", id)) {
		t.Fatal("another folder's session was touched")
	}
}

func TestDeleteSessionRefusesWhatIsNoSessionID(t *testing.T) {
	config := t.TempDir()
	for _, id := range []string{"../../etc", "a/b/c/d/e/f", "", ".hidden-file"} {
		if _, err := deleteSession(t, config, "/home/me/my_app", id); err == nil {
			t.Errorf("DeleteSession(%q) did not fail", id)
		}
	}
	params, _ := json.Marshal(DeleteSessionParams{SessionID: "11111111-1111-4111-8111-111111111111", ConfigDir: config})
	if _, err := New().DeleteSession(context.Background(), params); err == nil {
		t.Error("DeleteSession without a cwd did not fail")
	}
}

func TestFileSizesTellsTranscriptsSizes(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "rollout-1.jsonl")
	if err := os.WriteFile(transcript, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "notes.txt")
	writeFile(t, other)
	folder := filepath.Join(dir, "folder.jsonl")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(FileSizesParams{Paths: []string{
		transcript, other, folder, filepath.Join(dir, "missing.jsonl"), "relative.jsonl",
	}})
	result, err := New().FileSizes(context.Background(), params)
	if err != nil {
		t.Fatalf("FileSizes: %v", err)
	}
	sizes := result.(FileSizesResult).Sizes
	if len(sizes) != 1 || sizes[transcript] != 10 {
		t.Fatalf("sizes = %v, want only %s: 10", sizes, transcript)
	}
}
