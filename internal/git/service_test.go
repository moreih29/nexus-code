package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const processTimeout = time.Minute

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

func TestGetFileContentUnmergedReturnsUnmergedKind(t *testing.T) {
	t.Parallel()
	root := newConflictRepo(t)

	mergeCmd := exec.Command("git", "merge", "feature")
	mergeCmd.Dir = root
	_ = mergeCmd.Run()

	content, err := os.ReadFile(filepath.Join(root, "conflict.txt"))
	if err != nil {
		t.Fatalf("read conflicted file: %v", err)
	}
	if !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("expected conflict markers in conflict.txt, got:\n%s", content)
	}

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

func TestGetFileContentSizeCap(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	runGit(t, root, "init", "-b", "main")
	writeFile(t, filepath.Join(root, "at-cap.txt"), strings.Repeat("a", maxGitFileContentBytes))
	writeFile(t, filepath.Join(root, "over-cap.txt"), strings.Repeat("a", maxGitFileContentBytes+1))
	runGit(t, root, "add", "at-cap.txt", "over-cap.txt")
	service := New(root)

	res, err := service.GetFileContent(context.Background(), mustJSON(t, FileContentParams{Ref: "INDEX", RelPath: "at-cap.txt"}))
	if err != nil {
		t.Fatalf("blob at the cap: %v", err)
	}
	if got := res.(map[string]any); got["kind"] != "ok" || got["sizeBytes"] != maxGitFileContentBytes || len(got["content"].(string)) != maxGitFileContentBytes {
		t.Fatalf("blob at the cap: kind=%v sizeBytes=%v", got["kind"], got["sizeBytes"])
	}
	_, err = service.GetFileContent(context.Background(), mustJSON(t, FileContentParams{Ref: "INDEX", RelPath: "over-cap.txt"}))
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("blob over the cap: err = %v, want read-limit error", err)
	}
}

func TestGetFileContentStopsReadingAtCap(t *testing.T) {
	fakeDir := t.TempDir()
	writeFakeGit(t, fakeDir, "#!/bin/sh\nexec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	service := New(t.TempDir())

	done := make(chan error, 1)
	go func() {
		_, err := service.GetFileContent(context.Background(), mustJSON(t, FileContentParams{Ref: "HEAD", RelPath: "big.bin"}))
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

func TestGetFileContentTextNotInUTF8IsBytes(t *testing.T) {
	t.Parallel()
	for name, data := range map[string][]byte{
		"latin1.txt":  []byte("caf\xe9\n"),
		"utf16le.txt": {0xff, 0xfe, 'h', 0, 'i', 0},
	} {
		result := buildFileReadResult(data)
		if result["encoding"] != "bytes" || result["content"] != "" || result["isBinary"] != false {
			t.Fatalf("%s: %#v", name, result)
		}
		if got, _ := result["bytes"].([]byte); string(got) != string(data) {
			t.Fatalf("%s: bytes = %q, want %q", name, got, data)
		}
	}
	if result := buildFileReadResult([]byte("hello\n")); result["encoding"] != "utf8" || result["content"] != "hello\n" {
		t.Fatalf("UTF-8: %#v", result)
	}
}
