package agentrun_test

import (
	"path/filepath"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentrun"
)

func TestWsIDDistinctPerVersion(t *testing.T) {
	root := "/home/user/project"
	if agentrun.WsID(root, "0.9.0") == agentrun.WsID(root, "0.9.1") {
		t.Fatal("two agent versions of one workspace share a wsId")
	}
}

func TestWsIDMatchesClient(t *testing.T) {
	if got, want := agentrun.WsID("/home/user/repo", "0.9.0"), "750ec38c28740580"; got != want {
		t.Fatalf("WsID = %q, want %q", got, want)
	}
}

func TestTryLockAcquireAndUnlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ws.lock")

	lock, err := agentrun.TryLock(path)
	if err != nil {
		t.Fatalf("TryLock (first): unexpected error: %v", err)
	}
	lock.Unlock()

	lock2, err := agentrun.TryLock(path)
	if err != nil {
		t.Fatalf("TryLock (after Unlock): unexpected error: %v", err)
	}
	lock2.Unlock()
}

func TestTryLockReturnsErrLockHeld(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ws.lock")

	lock, err := agentrun.TryLock(path)
	if err != nil {
		t.Fatalf("TryLock (first): %v", err)
	}
	defer lock.Unlock()

	_, err = agentrun.TryLock(path)
	if err != agentrun.ErrLockHeld {
		t.Fatalf("TryLock (second): got %v, want ErrLockHeld", err)
	}
}
