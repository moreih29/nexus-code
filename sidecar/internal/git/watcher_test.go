package git

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDebouncerCoalescesRapidTriggers(t *testing.T) {
	events := make(chan struct{}, 3)
	debouncer := newDebouncer(20*time.Millisecond, func() {
		events <- struct{}{}
	})
	defer debouncer.Close()

	debouncer.Trigger()
	debouncer.Trigger()
	debouncer.Trigger()

	select {
	case <-events:
		// expected one debounced event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for debounced event")
	}

	select {
	case <-events:
		t.Fatal("got second event; want coalesced single event")
	case <-time.After(60 * time.Millisecond):
	}
}

func TestFSNotifyWatcherEmitsDebouncedChangeForWorkingTreeAndGitDirectory(t *testing.T) {
	tempDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(tempDir, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}

	events := make(chan struct{}, 4)
	watcher, err := NewFSNotifyWatcher(WatcherOptions{
		Cwd:      tempDir,
		Debounce: 20 * time.Millisecond,
		OnChange: func() {
			events <- struct{}{}
		},
	})
	if err != nil {
		t.Fatalf("NewFSNotifyWatcher() error = %v", err)
	}
	defer watcher.Close()

	if err := os.WriteFile(filepath.Join(tempDir, "worktree.txt"), []byte("change"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForWatcherEvent(t, events)

	if err := os.WriteFile(filepath.Join(tempDir, ".git", "index"), []byte("index"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForWatcherEvent(t, events)
}

func waitForWatcherEvent(t *testing.T, events <-chan struct{}) {
	t.Helper()
	select {
	case <-events:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for watcher event")
	}
}
