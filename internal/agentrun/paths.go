// Package agentrun manages per-workspace daemon runtime files:
// socket, lock, and log files under ~/.nexus-code/run/<wsId>.{sock,lock,log}.
//
// wsId is a short SHA-256 hex digest of the workspace root path, truncated
// to 16 characters. 16 hex chars = 64 bits of collision resistance, which is
// far more than needed for a single-user local set of workspaces.
//
// macOS sun_path limit: UNIX_PATH_MAX is 104 bytes on macOS (vs 108 on Linux).
// ~/.nexus-code/run/ is typically ~30 chars; "h-" prefix + 16-char hash + ".sock"
// suffix = 22 chars; total ≈ 52 chars — well within the 104-byte limit.
// (The hookserver hits the same constraint; see hookserver/server.go for the
// parallel pattern with its own 12-char hash.)
package agentrun

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// Paths holds the three runtime files for one workspace daemon instance.
type Paths struct {
	// Sock is the Unix domain socket the daemon listens on.
	// A dialer connects here; the client drives it with `agent --dial <Sock>`.
	Sock string
	// Lock is the flock(2) file that enforces the single-daemon invariant.
	// The daemon acquires LOCK_EX|LOCK_NB on this file before binding the
	// socket; a second contender that cannot acquire the lock becomes a dialer.
	Lock string
	// Log is the file where the daemon redirects its stderr after setsid(2)
	// detaches it from the SSH session's controlling terminal. Without it,
	// boot failures would be silently lost.
	Log string
}

// WsID computes the short workspace identifier for rootPath.
// It is a truncated SHA-256 hex digest (16 chars = 64 bits) of the
// canonical rootPath string — stable across reboots, collision-resistant
// for any realistic number of local workspaces, and short enough to keep
// the resulting socket path within macOS's 104-byte sun_path limit.
func WsID(rootPath string) string {
	h := sha256.Sum256([]byte(rootPath))
	return hex.EncodeToString(h[:])[:16]
}

// For returns the Paths for a workspace identified by rootPath.
// The caller must still call agentpaths.EnsureDir on the run directory
// before using these paths — For does not create any files or directories.
func For(rootPath string) (Paths, error) {
	runDir, err := agentpaths.RunDir()
	if err != nil {
		return Paths{}, fmt.Errorf("agentrun: %w", err)
	}
	id := WsID(rootPath)
	return Paths{
		Sock: filepath.Join(runDir, id+".sock"),
		Lock: filepath.Join(runDir, id+".lock"),
		Log:  filepath.Join(runDir, id+".log"),
	}, nil
}
