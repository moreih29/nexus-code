package agent_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/filewatch"

	"github.com/nexus-code/nexus-code/internal/fs"
)

func call(t *testing.T, handler func(context.Context, json.RawMessage) (any, error), params any) any {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	result, err := handler(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func filesystem(t *testing.T) (string, *fs.Service) {
	t.Helper()
	root := t.TempDir()
	service, err := fs.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return root, service
}

func TestSymlinkSaveUsesTargetMetadata(t *testing.T) {
	root, service := filesystem(t)
	target := filepath.Join(root, "target.txt")
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(target, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("original")
	if err := os.Symlink("target.txt", filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	read := call(t, service.ReadFile, map[string]string{"relPath": "link.txt"}).(fs.ReadFileResult)
	if read.Size != int64(len("original")) {
		t.Fatalf("read size = %d", read.Size)
	}
	stat := call(t, service.Stat, map[string]any{"relPath": "link.txt", "followSymlink": true}).(fs.StatResult)
	if stat.Size != read.Size || stat.MTime != read.MTime {
		t.Fatalf("stat = %#v, read = %#v", stat, read)
	}

	save := func(content string, mtime *string, size *int64) fs.WriteFileResult {
		t.Helper()
		return call(t, service.WriteFile, fs.WriteFileParams{
			RelPath: "link.txt", Content: content,
			Expected: &fs.ExpectedFileState{Exists: true, MTime: mtime, Size: size},
		}).(fs.WriteFileResult)
	}
	first := save("first edit", &read.MTime, &read.Size)
	if first.Kind != "ok" {
		t.Fatalf("first save = %#v", first)
	}
	second := save("second edit", first.MTime, first.Size)
	if second.Kind != "ok" {
		t.Fatalf("second save = %#v", second)
	}
	write("external change with different size")
	if third := save("stale edit", second.MTime, second.Size); third.Kind != "conflict" {
		t.Fatalf("save after external edit = %#v", third)
	}
	actual, err := os.ReadFile(target)
	if err != nil || string(actual) != "external change with different size" {
		t.Fatalf("target = %q, err = %v", actual, err)
	}
	if _, err := os.Readlink(filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestWriteFileWithLongBasename(t *testing.T) {
	root, service := filesystem(t)
	name := strings.Repeat("n", 251) + ".txt"
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Skipf("test filesystem does not allow the fixture name: %v", err)
	}
	result := call(t, service.WriteFile, fs.WriteFileParams{RelPath: name, Content: "after"}).(fs.WriteFileResult)
	if result.Kind != "ok" {
		t.Fatalf("save = %#v", result)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "after" {
		t.Fatalf("saved content = %q, err = %v", got, err)
	}
}

func TestWatchReportsCreateFollowedByWriteAsAdded(t *testing.T) {
	root, service := filesystem(t)
	changes := make(chan filewatch.FsChange, 4)
	service.SetEventSink(func(_ string, payload any) error {
		for _, change := range payload.(filewatch.FsChangedPayload).Changes {
			changes <- change
		}
		return nil
	})
	call(t, service.Watch, fs.WatchParams{RelPath: "."})
	file, err := os.Create(filepath.Join(root, "new.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	time.Sleep(50 * time.Millisecond)
	if _, err := file.WriteString("new content"); err != nil {
		t.Fatal(err)
	}
	select {
	case change := <-changes:
		if change.RelPath != "new.txt" || change.Kind != filewatch.FsChangeAdded {
			t.Fatalf("create and write notified as %#v", change)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no creation event")
	}
}
