package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// processTimeout bounds a test's wait on a git process. It only has to catch
// a hang, and a loaded Windows CI runner has taken over ten seconds to start
// git and its askpass helper.
const processTimeout = time.Minute

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
	t.Parallel()
	root := newConflictRepo(t)

	// Attempt merge — expect conflict; ignore the error.
	mergeCmd := exec.Command("git", "merge", "feature")
	mergeCmd.Dir = root
	_ = mergeCmd.Run()

	// Verify we actually have a conflict by checking for conflict markers.
	content, err := os.ReadFile(filepath.Join(root, "conflict.txt"))
	if err != nil {
		t.Fatalf("read conflicted file: %v", err)
	}
	if !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("expected conflict markers in conflict.txt, got:\n%s", content)
	}

	// Now call GetFileContent with INDEX ref — should return {kind:"unmerged"}.
	d := dispatch.New()
	service := New(root)
	Register(d, service)

	params, _ := json.Marshal(FileContentParams{Ref: "INDEX", RelPath: "conflict.txt"})
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

// TestGetFileContentSizeCap checks the 5 MiB cap on both sides of the edge.
func TestGetFileContentSizeCap(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	runGit(t, root, "init", "-b", "main")
	writeFile(t, filepath.Join(root, "at-cap.txt"), strings.Repeat("a", maxGitFileContentBytes))
	writeFile(t, filepath.Join(root, "over-cap.txt"), strings.Repeat("a", maxGitFileContentBytes+1))
	runGit(t, root, "add", "at-cap.txt", "over-cap.txt")
	service := New(root)

	res, err := service.GetFileContent(context.Background(), mustRawJSON(t, FileContentParams{Ref: "INDEX", RelPath: "at-cap.txt"}))
	if err != nil {
		t.Fatalf("blob at the cap: %v", err)
	}
	if got := res.(map[string]any); got["kind"] != "ok" || got["sizeBytes"] != maxGitFileContentBytes || len(got["content"].(string)) != maxGitFileContentBytes {
		t.Fatalf("blob at the cap: kind=%v sizeBytes=%v", got["kind"], got["sizeBytes"])
	}
	_, err = service.GetFileContent(context.Background(), mustRawJSON(t, FileContentParams{Ref: "INDEX", RelPath: "over-cap.txt"}))
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("blob over the cap: err = %v, want read-limit error", err)
	}
}

// TestGetFileContentStopsReadingAtCap — the blob used to be read whole with
// cmd.Output() before the size check, so a huge blob was buffered in full
// only to be rejected. The fake git here never stops writing: the read must
// stop at the cap and kill it.
func TestGetFileContentStopsReadingAtCap(t *testing.T) {
	fakeDir := t.TempDir()
	writeFakeGit(t, fakeDir, "#!/bin/sh\nexec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	service := New(t.TempDir())

	done := make(chan error, 1)
	go func() {
		_, err := service.GetFileContent(context.Background(), mustRawJSON(t, FileContentParams{Ref: "HEAD", RelPath: "big.bin"}))
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("err = %v, want read-limit error", err)
		}
	case <-time.After(processTimeout):
		t.Fatal("GetFileContent kept reading past the size cap")
	}
}

func mustRawJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// ---------------------------------------------------------------------------
// GetFileContent: non-conflicted INDEX entry still returns content normally
// ---------------------------------------------------------------------------

func TestGetFileContentIndexNormalFile(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	runGit(t, root, "init", "-b", "main")
	writeFile(t, filepath.Join(root, "file.txt"), "hello\n")
	runGit(t, root, "add", "file.txt")

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

// TestRegisterExposesMethods checks that Register binds the wire names the
// host calls. The handlers have tests of their own.
func TestRegisterExposesMethods(t *testing.T) {
	d := dispatch.New()
	Register(d, New(t.TempDir()))
	registered := d.Methods()
	for _, method := range []string{
		"git.status",
		"git.diff",
		"git.commitDetail",
		"git.stash.list",
		"git.stash.apply",
		"git.stash.drop",
		"git.stash.group",
		"git.tag.list",
		"git.tag.create",
		"git.tag.delete",
		"git.remote.add",
		"git.remote.remove",
		"git.workflow.merge",
		"git.workflow.rebase",
		"git.workflow.cherryPick",
		"git.workflow.abort",
		"git.workflow.continue",
		"git.conflict.markResolved",
	} {
		if !slices.Contains(registered, method) {
			t.Errorf("%s is not registered", method)
		}
	}
}
