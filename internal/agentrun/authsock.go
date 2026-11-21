//go:build !windows

package agentrun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxSunPath is the smallest sun_path size among supported hosts (macOS: 104
// bytes, Linux: 108), including the terminating NUL.
const maxSunPath = 104

// AuthSockFor returns the stable SSH agent socket path that belongs to the
// daemon listening on sockPath: <wsId>.agent next to <wsId>.sock.
//
// The daemon outlives the SSH connection that started it, but a forwarded
// agent socket ($SSH_AUTH_SOCK) lives only as long as its connection. The
// daemon therefore exports this path instead, a symlink that every dialer
// re-points at its own connection's agent socket.
func AuthSockFor(sockPath string) string {
	return strings.TrimSuffix(sockPath, ".sock") + ".agent"
}

// PointAuthSock makes link a symlink to the agent socket target, replacing
// the previous target atomically so a process connecting meanwhile sees
// either socket, never a missing path. It does nothing when target is not a
// socket (no agent forwarded) or is link itself.
func PointAuthSock(link, target string) error {
	if target == "" || filepath.Clean(target) == link {
		return nil
	}
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("agentrun: %s is not a socket", target)
	}
	tmp := fmt.Sprintf("%s.%d.tmp", link, os.Getpid())
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// SetConnectionAuthSock records the current dialer's forwarding state.
// A non-forwarding connection must not keep using the previous socket.
func SetConnectionAuthSock(link, target string) error {
	if target != "" {
		return PointAuthSock(link, target)
	}
	if _, err := os.Readlink(link); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return os.Remove(link)
}

// AdoptAuthSock exports the stable socket pathname. Children can inherit
// it before the first forwarding connection supplies a target.
func AdoptAuthSock(link string) bool {
	if len(link) >= maxSunPath {
		return false
	}
	if err := SetConnectionAuthSock(link, os.Getenv("SSH_AUTH_SOCK")); err != nil {
		return false
	}
	return os.Setenv("SSH_AUTH_SOCK", link) == nil
}
