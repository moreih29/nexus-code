package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// isUnmergedIndexEntry unit tests
// ---------------------------------------------------------------------------

func TestIsUnmergedIndexEntry(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   bool
	}{
		{
			name:   "exact git error string",
			stderr: "fatal: path 'foo.txt' is in the index, but not at stage 0",
			want:   true,
		},
		{
			name:   "multiline stderr with unmerged message",
			stderr: "error: something else\nfatal: path 'bar.go' is in the index, but not at stage 0\n",
			want:   true,
		},
		{
			name:   "regular missing path (stage 0 not mentioned)",
			stderr: "fatal: Path 'foo.txt' does not exist in 'HEAD'",
			want:   false,
		},
		{
			name:   "invalid object name",
			stderr: "fatal: invalid object name 'HEAD'",
			want:   false,
		},
		{
			name:   "empty stderr",
			stderr: "",
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isUnmergedIndexEntry(tc.stderr)
			if got != tc.want {
				t.Errorf("isUnmergedIndexEntry(%q) = %v, want %v", tc.stderr, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// GetFileContent integration: unmerged INDEX entry returns {kind:"unmerged"}
// ---------------------------------------------------------------------------

// TestGetFileContentUnmergedReturnsUnmergedKind creates a real merge conflict
// in a temp repo and verifies that GetFileContent with ref=INDEX returns
// {kind:"missing", reason:"index"} instead of propagating the raw fatal error.
func TestGetFileContentUnmergedReturnsUnmergedKind(t *testing.T) {
	root := t.TempDir()

	// Set up repo with initial commit on main.
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGitCommand(t, root, "add", "file.txt")
	runGitCommand(t, root, "commit", "-m", "initial")

	// Create a branch with a conflicting change.
	runGitCommand(t, root, "checkout", "-b", "branch")
	writeFile(t, filepath.Join(root, "file.txt"), "branch change\n")
	runGitCommand(t, root, "add", "file.txt")
	runGitCommand(t, root, "commit", "-m", "branch commit")

	// Return to main and make a conflicting change.
	runGitCommand(t, root, "checkout", "main")
	writeFile(t, filepath.Join(root, "file.txt"), "main change\n")
	runGitCommand(t, root, "add", "file.txt")
	runGitCommand(t, root, "commit", "-m", "main commit")

	// Attempt merge — expect conflict; ignore the error.
	mergeCmd := exec.Command("git", "merge", "branch")
	mergeCmd.Dir = root
	_ = mergeCmd.Run()

	// Verify we actually have a conflict by checking for conflict markers.
	content, err := os.ReadFile(filepath.Join(root, "file.txt"))
	if err != nil {
		t.Fatalf("read conflicted file: %v", err)
	}
	if !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("expected conflict markers in file.txt, got:\n%s", content)
	}

	// Now call GetFileContent with INDEX ref — should return {kind:"unmerged"}.
	d := dispatch.New()
	service := New(root)
	Register(d, service)

	params, _ := json.Marshal(FileContentParams{Ref: "INDEX", RelPath: "file.txt"})
	res := d.Dispatch(context.Background(), proto.Request{
		ID:     "1",
		Method: "git.getFileContent",
		Params: params,
	})

	if res.Error != nil {
		t.Fatalf("GetFileContent returned IPC error: code=%q msg=%q (expected unmerged result, not error)",
			res.Error.Code, res.Error.Message)
	}

	result, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", res.Result)
	}
	kind, _ := result["kind"].(string)
	if kind != "missing" {
		t.Errorf("result kind = %q, want %q (unmerged files map to missing/index)", kind, "missing")
	}
	reason, _ := result["reason"].(string)
	if reason != "index" {
		t.Errorf("result reason = %q, want %q", reason, "index")
	}
}

// ---------------------------------------------------------------------------
// GetFileContent: non-conflicted INDEX entry still returns content normally
// ---------------------------------------------------------------------------

func TestGetFileContentIndexNormalFile(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "file.txt"), "hello\n")
	runGitCommand(t, root, "add", "file.txt")

	d := dispatch.New()
	service := New(root)
	Register(d, service)

	params, _ := json.Marshal(FileContentParams{Ref: "INDEX", RelPath: "file.txt"})
	res := d.Dispatch(context.Background(), proto.Request{
		ID:     "2",
		Method: "git.getFileContent",
		Params: params,
	})

	if res.Error != nil {
		t.Fatalf("GetFileContent returned error for staged file: %#v", res.Error)
	}
	result, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", res.Result)
	}
	if result["kind"] != "ok" {
		t.Errorf("result kind = %q, want %q", result["kind"], "ok")
	}
}
