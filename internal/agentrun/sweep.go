package agentrun

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// staleLogRetention is how long a dead workspace's boot log is kept before
// the sweep removes it. Recent logs are post-mortem evidence (why did that
// daemon die?); week-old logs of a workspace nobody reconnected to are litter.
const staleLogRetention = 7 * 24 * time.Hour

// SweepStale removes runtime litter left in runDir by dead daemons of OTHER
// workspaces. It is called once at daemon boot, after the caller has acquired
// its own workspace lock.
//
// Liveness is decided by flock(2), never by file age: a live daemon holds an
// exclusive flock on its <wsId>.lock for its entire lifetime, released by the
// kernel the instant the process dies. For each foreign workspace:
//
//   - flock acquired → that workspace's daemon is provably dead. Its .sock is
//     removed (a socket with no listener is worthless), and its .log is
//     removed only when older than staleLogRetention.
//   - flock denied (EWOULDBLOCK) → daemon alive. Nothing is touched.
//   - flock unsupported (network FS) or .lock missing → liveness cannot be
//     proven. Nothing is touched. TryLock's PID fallback is deliberately NOT
//     used here: it writes the probing process's PID into the foreign lock
//     file, which would make the foreign workspace's next daemon read us as
//     its owner.
//
// The .lock file itself is never removed: unlinking a lock file while holding
// its flock opens the classic race where a concurrently starting daemon
// re-creates the path and locks a different inode, breaking the single-daemon
// invariant. A zero-byte lock file is not litter.
//
// Best-effort: I/O errors skip the entry. Returns the removed paths so the
// caller can log them.
func SweepStale(runDir, ownWsID string) []string {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return nil
	}
	var removed []string
	seen := make(map[string]bool)
	for _, entry := range entries {
		name := entry.Name()
		ext := filepath.Ext(name)
		if ext != ".lock" && ext != ".sock" && ext != ".log" {
			continue
		}
		id := strings.TrimSuffix(name, ext)
		if !isWsID(id) || id == ownWsID || seen[id] {
			continue
		}
		seen[id] = true
		removed = append(removed, sweepWorkspace(runDir, id)...)
	}
	return removed
}

// isWsID reports whether s looks like a WsID: exactly 16 lowercase hex chars.
// Anything else in the run directory was not produced by agentrun and is
// never touched by the sweep.
func isWsID(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// sweepWorkspace probes one foreign workspace's lock and, when its daemon is
// provably dead, removes the stale socket and any over-retention log.
func sweepWorkspace(runDir, id string) []string {
	lockPath := filepath.Join(runDir, id+".lock")
	// O_CREATE is deliberately absent: probing must not manufacture new
	// lock files for workspaces that never had one.
	f, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
	if err != nil {
		return nil
	}
	// Closing the fd releases the flock.
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Held (daemon alive) or flock unsupported (liveness unprovable) —
		// either way, hands off.
		return nil
	}

	var removed []string
	sockPath := filepath.Join(runDir, id+".sock")
	if err := os.Remove(sockPath); err == nil {
		removed = append(removed, sockPath)
	}
	logPath := filepath.Join(runDir, id+".log")
	if fi, err := os.Stat(logPath); err == nil && time.Since(fi.ModTime()) > staleLogRetention {
		if err := os.Remove(logPath); err == nil {
			removed = append(removed, logPath)
		}
	}
	return removed
}

// CapLogSize truncates the file at path to zero when it has grown beyond
// maxBytes. The daemon opens its boot log in append mode and the file
// survives every restart, so a long-lived workspace would otherwise grow it
// without bound (there is no log rotation). Called before the log is opened
// at boot; losing the previous runs' history once per maxBytes is an
// acceptable trade for a hard size ceiling.
//
// Returns true when the file was truncated. Missing file or I/O errors are
// best-effort no-ops.
func CapLogSize(path string, maxBytes int64) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.Size() <= maxBytes {
		return false
	}
	return os.Truncate(path, 0) == nil
}
