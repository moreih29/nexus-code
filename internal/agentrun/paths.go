// Package agentrun manages per-workspace daemon runtime files:
// socket, lock, and log files under ~/.nexus-code/run/<wsId>.{sock,lock,log},
// plus the <wsId>.agent link to the current connection's SSH agent socket.
//
// wsId is a short SHA-256 hex digest of the workspace root path and the agent
// version, truncated to 16 characters. 16 hex chars = 64 bits of collision
// resistance, which is far more than needed for a single-user local set of
// workspaces.
//
// If the home path is too long for a Unix socket, the socket and forwarded
// agent link use a short private directory while lock and log stay in run.
package agentrun

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// Paths holds the runtime files for one workspace daemon instance.
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
	// AuthSock is the symlink the daemon exports as $SSH_AUTH_SOCK when the
	// SSH connection forwards an agent; see AuthSockFor.
	AuthSock string
}

// WsID computes the short identifier of the daemon that serves rootPath at
// agent version. It is a truncated SHA-256 hex digest (16 chars = 64 bits)
// of both — stable across reboots, collision-resistant for any realistic
// number of local workspaces, and short enough to keep the resulting socket
// path within macOS's 104-byte sun_path limit.
//
// The version keeps each version's daemon apart. A daemon outlives the app
// that started it, so an app updated and relaunched within the reattach
// grace would otherwise reach the previous version's daemon through the
// shared socket and run its code — without its methods and fixes — until
// that daemon exited. Instead the new version starts its own daemon, and the
// old one exits once no dialer is left.
func WsID(rootPath, version string) string {
	h := sha256.Sum256([]byte(version + "\x00" + rootPath))
	return hex.EncodeToString(h[:])[:16]
}

// For returns the Paths for the daemon of rootPath at agent version.
// The caller must still call agentpaths.EnsureDir on the run directory
// before using these paths — For does not create any files or directories.
func For(rootPath, version string) (Paths, error) {
	runDir, err := agentpaths.RunDir()
	if err != nil {
		return Paths{}, fmt.Errorf("agentrun: %w", err)
	}
	id := WsID(rootPath, version)
	socketDir := runSocketDir(runDir, id+".agent")
	return Paths{
		Sock:     filepath.Join(socketDir, id+".sock"),
		Lock:     filepath.Join(runDir, id+".lock"),
		Log:      filepath.Join(runDir, id+".log"),
		AuthSock: filepath.Join(socketDir, id+".agent"),
	}, nil
}

// EnsureSocketDir prepares the directory for binding or dialing the socket.
func (p Paths) EnsureSocketDir() error {
	dir := filepath.Dir(p.Sock)
	if dir == filepath.Dir(p.Lock) {
		return agentpaths.EnsureDir(dir)
	}
	return ensurePrivateSocketDir(dir)
}
