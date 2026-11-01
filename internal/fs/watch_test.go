package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A watched directory that is deleted and recreated at the same path must be
// watchable again. fsnotify drops the OS watch on delete but keeps its
// channels open; if the service kept the stale entry, the second Watch call
// would be a no-op and changes inside the recreated directory would never
// be reported.
func TestWatchRecreatedDirectoryIsWatchedAgain(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	must(t, os.Mkdir(sub, 0o755))

	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()

	changes := make(chan FsChange, 64)
	fsys.SetEventSink(func(event string, payload any) error {
		if p, ok := payload.(FsChangedPayload); ok && event == "fs.changed" {
			for _, c := range p.Changes {
				changes <- c
			}
		}
		return nil
	})

	params := json.RawMessage(`{"relPath":"sub"}`)
	if _, err := fsys.Watch(context.Background(), params); err != nil {
		t.Fatal(err)
	}

	must(t, os.RemoveAll(sub))
	waitFor(t, func() bool {
		fsys.mu.Lock()
		defer fsys.mu.Unlock()
		_, exists := fsys.watches[fsys.root+string(filepath.Separator)+"sub"]
		return !exists
	})

	must(t, os.Mkdir(sub, 0o755))
	if _, err := fsys.Watch(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(sub, "new.txt"), []byte("x"), 0o644))

	deadline := time.After(5 * time.Second)
	for {
		select {
		case c := <-changes:
			if c.RelPath == "sub/new.txt" {
				return
			}
		case <-deadline:
			t.Fatal("no fs.changed for sub/new.txt after the directory was recreated")
		}
	}
}

// fs.watch must keep working past Linux's per-user inotify instance limit
// (128 by default). With one fsnotify.Watcher per directory, watch #114
// failed with "too many open files".
// Watching a file is the wrong kind of path, not a directory opened as a
// file, so it must not report IS_DIRECTORY.
func TestWatchFileReportsNotDirectory(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644))

	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()

	_, err = fsys.Watch(context.Background(), watchParams("a.txt"))
	assertFSError(t, err, CodeNotDirectory)
}

func TestWatchManyDirectories(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	changes := collectChanges(fsys)

	const n = 300
	for i := 0; i < n; i++ {
		rel := fmt.Sprintf("d%03d", i)
		must(t, os.Mkdir(filepath.Join(root, rel), 0o755))
		if _, err := fsys.Watch(context.Background(), watchParams(rel)); err != nil {
			t.Fatalf("fs.watch #%d: %v", i+1, err)
		}
	}

	must(t, os.WriteFile(filepath.Join(root, "d000", "a.txt"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "d299", "a.txt"), []byte("x"), 0o644))
	waitForChanges(t, changes, "d000/a.txt", "d299/a.txt")

	// Unwatching one directory stops its events and leaves the rest alone.
	if _, err := fsys.Unwatch(context.Background(), watchParams("d000")); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(root, "d000", "b.txt"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "d299", "b.txt"), []byte("x"), 0o644))
	if seen := waitForChanges(t, changes, "d299/b.txt"); seen["d000/b.txt"] {
		t.Fatal("fs.changed reported d000/b.txt after d000 was unwatched")
	}
}

// Collapsing a subdirectory unwatches it while its parent stays watched; the
// parent must still report the subdirectory being deleted. (This is why
// macOS keeps one kqueue watcher per directory: on a shared one, unwatching
// the subdirectory also drops the parent's watch on it.)
func TestWatchParentReportsUnwatchedSubdirectoryDeleted(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "p", "c"), 0o755))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	changes := collectChanges(fsys)

	for _, rel := range []string{"p", "p/c"} {
		if _, err := fsys.Watch(context.Background(), watchParams(rel)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fsys.Unwatch(context.Background(), watchParams("p/c")); err != nil {
		t.Fatal(err)
	}
	must(t, os.RemoveAll(filepath.Join(root, "p", "c")))
	waitForChanges(t, changes, "p/c")
}

// A symlinked directory is watchable like any other: the workspace root
// itself may be a symlink, and fs.watch("") failed with IS_DIRECTORY there.
// A symlinked directory and its target are watched side by side and report
// changes under both paths.
func TestWatchSymlinkedDirectory(t *testing.T) {
	t.Parallel()
	real := t.TempDir()
	must(t, os.Mkdir(filepath.Join(real, "target"), 0o755))
	if err := os.Symlink("target", filepath.Join(real, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	root := filepath.Join(t.TempDir(), "ws")
	must(t, os.Symlink(real, root))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	changes := collectChanges(fsys)

	for _, rel := range []string{"", "link", "target"} {
		if _, err := fsys.Watch(context.Background(), watchParams(rel)); err != nil {
			t.Fatalf("fs.watch %q: %v", rel, err)
		}
	}
	must(t, os.WriteFile(filepath.Join(real, "top.txt"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(real, "target", "new.txt"), []byte("x"), 0o644))
	waitForChanges(t, changes, "top.txt", "link/new.txt", "target/new.txt")
}

func watchParams(rel string) json.RawMessage {
	raw, _ := json.Marshal(WatchParams{RelPath: rel})
	return raw
}

func collectChanges(fsys *Service) <-chan FsChange {
	changes := make(chan FsChange, 1024)
	fsys.SetEventSink(func(event string, payload any) error {
		if p, ok := payload.(FsChangedPayload); ok && event == "fs.changed" {
			for _, c := range p.Changes {
				changes <- c
			}
		}
		return nil
	})
	return changes
}

// waitForChanges waits until every relPath in want has been reported and
// returns every relPath seen up to then.
func waitForChanges(t *testing.T, changes <-chan FsChange, want ...string) map[string]bool {
	t.Helper()
	seen := make(map[string]bool)
	deadline := time.After(5 * time.Second)
	for {
		missing := 0
		for _, rel := range want {
			if !seen[rel] {
				missing++
			}
		}
		if missing == 0 {
			return seen
		}
		select {
		case c := <-changes:
			seen[c.RelPath] = true
		case <-deadline:
			t.Fatalf("no fs.changed for all of %v within 5s; saw %v", want, seen)
		}
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within 5s")
}
