package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestNormalizeConflictPathValid(t *testing.T) {
	cases := []struct {
		relPath string
		want    string
	}{
		{"file.txt", "file.txt"},
		{"sub/file.txt", "sub/file.txt"},
		{"  file.txt  ", "file.txt"},
	}
	for _, c := range cases {
		got, err := normalizeConflictPath("/repo", c.relPath)
		if err != nil {
			t.Errorf("normalizeConflictPath(%q) error = %v, want nil", c.relPath, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeConflictPath(%q) = %q, want %q", c.relPath, got, c.want)
		}
	}
}

func TestNormalizeConflictPathRejectsAbsolute(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "/etc/passwd")
	if err == nil {
		t.Error("normalizeConflictPath with absolute path should return error")
	}
}

func TestNormalizeConflictPathRejectsEmpty(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "")
	if err == nil {
		t.Error("normalizeConflictPath with empty path should return error")
	}
}

func TestNormalizeConflictPathRejectsTraversal(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "../outside")
	if err == nil {
		t.Error("normalizeConflictPath with traversal should return error")
	}
}

func TestConflictedPathSet(t *testing.T) {
	old := "old.txt"
	status := GitStatus{
		Merge: []GitStatusEntry{
			{RelPath: "conflict.txt"},
			{RelPath: "renamed.txt", OldRelPath: &old},
		},
	}
	set := conflictedPathSet(status)
	if !set["conflict.txt"] {
		t.Error("conflictedPathSet missing conflict.txt")
	}
	if !set["renamed.txt"] {
		t.Error("conflictedPathSet missing renamed.txt")
	}
	if !set["old.txt"] {
		t.Error("conflictedPathSet missing old.txt (OldRelPath)")
	}
}

func TestConflictMarkResolvedNotConflictedReturnsError(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]any{"cwd": root, "relPaths": []string{"README.md"}})
	_, err := service.ConflictMarkResolved(context.Background(), raw)
	if err == nil {
		t.Fatal("ConflictMarkResolved with non-conflicted path should return error")
	}
}

func TestConflictMarkResolvedResolvesConflict(t *testing.T) {
	t.Parallel()
	root := newConflictRepo(t)
	service := New(root)

	mergeRaw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	_, _ = service.WorkflowMerge(context.Background(), mergeRaw)

	writeFile(t, filepath.Join(root, "conflict.txt"), "resolved\n")

	resolveRaw, _ := json.Marshal(map[string]any{"cwd": root, "relPaths": []string{"conflict.txt"}})
	result, err := service.ConflictMarkResolved(context.Background(), resolveRaw)
	if err != nil {
		t.Fatalf("ConflictMarkResolved: %v", err)
	}
	cr, ok := result.(ConflictMarkResolvedResult)
	if !ok {
		t.Fatalf("ConflictMarkResolved result type = %T, want ConflictMarkResolvedResult", result)
	}
	if cr.RemainingConflicts != 0 {
		t.Errorf("ConflictMarkResolved remainingConflicts = %d, want 0", cr.RemainingConflicts)
	}
}
