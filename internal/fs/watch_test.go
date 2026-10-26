package fs

import (
	"context"
	"encoding/json"
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
