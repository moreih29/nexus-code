package agentrun

import (
	"errors"
	"fmt"
	"os"
)

// Lock holds an exclusive flock(2) on a workspace lock file, ensuring that
// at most one daemon owns a given workspace at a time. Windows takes a
// LockFileEx lock instead (lock_windows.go).
//
// If the file system does not support flock (e.g. some network mounts), the
// syscall returns ENOTSUP or EOPNOTSUPP. In that case we fall back to a
// PID-file check: write our own PID and attempt kill(pid, 0) on whatever
// was there before. This keeps the invariant on the common cases (local ext4,
// APFS, tmpfs) while degrading gracefully on NFS.
type Lock struct {
	file *os.File
}

// ErrLockHeld is returned by TryLock when another process already holds the
// workspace lock, meaning a daemon is already running. The caller should
// switch to dialer mode (connect to the socket) instead of starting a new
// daemon.
var ErrLockHeld = errors.New("agentrun: workspace lock held by another process — daemon already running")

// TryLock opens (or creates) the lock file at path and attempts to acquire
// an exclusive non-blocking flock. Returns ErrLockHeld when the lock is
// already held. The returned *Lock must be released by calling Unlock when
// the daemon shuts down, so the lock file is left in a clean state.
func TryLock(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("agentrun: open lock file %q: %w", path, err)
	}

	if err := lockFile(f); err != nil {
		f.Close()
		if errors.Is(err, errLockBusy) {
			return nil, ErrLockHeld
		}
		// The file system has no locks: fall back to a PID-file liveness check.
		if errors.Is(err, errLockUnsupported) {
			return tryLockPIDFallback(path)
		}
		return nil, fmt.Errorf("agentrun: lock %q: %w", path, err)
	}

	return &Lock{file: f}, nil
}

// Unlock releases the flock and closes the lock file. Idempotent.
func (l *Lock) Unlock() {
	if l == nil || l.file == nil {
		return
	}
	// Closing the fd releases the flock automatically on POSIX.
	_ = l.file.Close()
	l.file = nil
}

// tryLockPIDFallback handles file systems where flock(2) returns ENOTSUP.
// It reads a PID from the lock file; if that process is still alive
// (kill(pid,0) succeeds) it returns ErrLockHeld. Otherwise it overwrites the
// file with our own PID and returns a Lock backed by the open fd.
func tryLockPIDFallback(path string) (*Lock, error) {
	data, readErr := os.ReadFile(path)
	if readErr == nil && len(data) > 0 {
		var pid int
		if _, err := fmt.Sscanf(string(data), "%d", &pid); err == nil && pid > 0 {
			if processAlive(pid) {
				// Process still alive — daemon is running.
				return nil, ErrLockHeld
			}
		}
	}

	// Previous daemon is gone: overwrite with our PID.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0600)
	if err != nil {
		return nil, fmt.Errorf("agentrun: pid-fallback open %q: %w", path, err)
	}
	if _, err := fmt.Fprintf(f, "%d\n", os.Getpid()); err != nil {
		f.Close()
		return nil, fmt.Errorf("agentrun: pid-fallback write %q: %w", path, err)
	}
	return &Lock{file: f}, nil
}
