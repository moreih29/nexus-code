package agentrun_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentrun"
)

// TestWsIDDistinct verifies that different roots produce different wsIds.
func TestWsIDDistinct(t *testing.T) {
	a := agentrun.WsID("/home/user/project-a", "1.2.3")
	b := agentrun.WsID("/home/user/project-b", "1.2.3")
	if a == b {
		t.Fatal("different roots produced the same wsId — collision")
	}
}

// An updated app relaunched while the previous version's daemon still waits
// out its reattach grace must start its own daemon, not reach the old one.
func TestWsIDDistinctPerVersion(t *testing.T) {
	root := "/home/user/project"
	if agentrun.WsID(root, "0.9.0") == agentrun.WsID(root, "0.9.1") {
		t.Fatal("two agent versions of one workspace share a wsId")
	}
}

// The SSH bootstrap computes the socket path on the client
// (computeWsId in ssh-bootstrap/index.ts); both sides must agree.
func TestWsIDMatchesClient(t *testing.T) {
	if got, want := agentrun.WsID("/home/user/repo", "0.9.0"), "750ec38c28740580"; got != want {
		t.Fatalf("WsID = %q, want %q", got, want)
	}
}

// TestNewEpochUnique verifies that two rapid calls to NewEpoch produce
// distinct values (the random component ensures this even within the same second).
func TestNewEpochUnique(t *testing.T) {
	a := agentrun.NewEpoch()
	b := agentrun.NewEpoch()
	// With 32 bits of randomness the probability of collision is 1 in 4 billion.
	if a == b {
		t.Fatal("NewEpoch returned identical values on two consecutive calls — RNG failure?")
	}
	if a == 0 || b == 0 {
		t.Fatal("NewEpoch returned zero — boot time encoding failed")
	}
}

// TestEpochContainsTimestamp verifies that the epoch encodes a plausible
// boot timestamp in the high 32 bits (within ±60 s of now).
func TestEpochContainsTimestamp(t *testing.T) {
	before := time.Now().Unix()
	epoch := agentrun.NewEpoch()
	after := time.Now().Unix()

	ts := int64(epoch >> 32)
	if ts < before-60 || ts > after+60 {
		t.Fatalf("epoch timestamp %d outside expected range [%d, %d]", ts, before, after)
	}
}

// TestTryLockAcquireAndUnlock verifies that TryLock succeeds on a fresh file and
// Unlock releases it so a second TryLock on the same path succeeds.
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

// TestTryLockReturnsErrLockHeld verifies that a second TryLock while the first is
// held returns ErrLockHeld — the daemon single-instance invariant.
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
