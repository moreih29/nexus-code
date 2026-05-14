package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ---------------------------------------------------------------------------
// Fixture directory helper
// ---------------------------------------------------------------------------

// conflictFixtureRoot returns the path to tests/fixtures/git/conflict.
func conflictFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "conflict"))
}

// ---------------------------------------------------------------------------
// Unit tests for path normalization helpers
// ---------------------------------------------------------------------------

// TestNormalizeConflictPathValid verifies valid relative paths are accepted.
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

// TestNormalizeConflictPathRejectsAbsolute verifies absolute paths are rejected.
func TestNormalizeConflictPathRejectsAbsolute(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "/etc/passwd")
	if err == nil {
		t.Error("normalizeConflictPath with absolute path should return error")
	}
}

// TestNormalizeConflictPathRejectsEmpty verifies empty paths are rejected.
func TestNormalizeConflictPathRejectsEmpty(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "")
	if err == nil {
		t.Error("normalizeConflictPath with empty path should return error")
	}
}

// TestNormalizeConflictPathRejectsTraversal verifies path traversal is rejected.
func TestNormalizeConflictPathRejectsTraversal(t *testing.T) {
	_, err := normalizeConflictPath("/repo", "../outside")
	if err == nil {
		t.Error("normalizeConflictPath with traversal should return error")
	}
}

// TestConflictedPathSet verifies conflictedPathSet collects both relPath and oldRelPath.
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

// ---------------------------------------------------------------------------
// Integration tests using real temp git repos
// ---------------------------------------------------------------------------

// TestConflictMarkResolvedEmptyParamsReturnsError verifies empty params are rejected.
func TestConflictMarkResolvedEmptyParamsReturnsError(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	_, err := service.ConflictMarkResolved(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("ConflictMarkResolved with empty params should return error")
	}
}

// TestConflictMarkResolvedEmptyPathsReturnsError verifies empty relPaths is rejected.
func TestConflictMarkResolvedEmptyPathsReturnsError(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]any{"cwd": root, "relPaths": []string{}})
	_, err := service.ConflictMarkResolved(context.Background(), raw)
	if err == nil {
		t.Fatal("ConflictMarkResolved with empty relPaths should return error")
	}
}

// TestConflictMarkResolvedNotConflictedReturnsError verifies non-conflicted path is rejected.
func TestConflictMarkResolvedNotConflictedReturnsError(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]any{"cwd": root, "relPaths": []string{"README.md"}})
	_, err := service.ConflictMarkResolved(context.Background(), raw)
	if err == nil {
		t.Fatal("ConflictMarkResolved with non-conflicted path should return error")
	}
}

// TestConflictMarkResolvedResolvesConflict verifies a conflicted path is staged and remaining count decreases.
func TestConflictMarkResolvedResolvesConflict(t *testing.T) {
	root := makeWorkflowConflictRepo(t)
	service := New(root)

	// Start a conflicting merge.
	mergeRaw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	_, _ = service.WorkflowMerge(context.Background(), mergeRaw)

	// Resolve the conflict by writing a clean version of the file.
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

// TestConflictFixturesExist logs a warning if the fixture root is absent.
func TestConflictFixturesExist(t *testing.T) {
	root := conflictFixtureRoot(t)
	if _, err := os.Stat(root); err != nil {
		t.Logf("conflict fixture root %q not yet present (will be created): %v", root, err)
	}
}
