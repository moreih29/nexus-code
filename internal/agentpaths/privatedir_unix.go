//go:build darwin || linux

package agentpaths

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func shortSocketDir(preferred string) (string, error) {
	return filepath.Join("/tmp", fmt.Sprintf("nexus-code-%d-%s", os.Getuid(), preferredHash(preferred))), nil
}

func EnsurePrivateDir(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return fmt.Errorf("agentpaths: cannot create socket directory %q: %w", dir, err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return cannotCheck(dir, err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm() != 0o700 || !ok || int(stat.Uid) != os.Getuid() {
		return notPrivateDir(dir)
	}
	return nil
}

func FreshPrivateSocketDir(longestName string) (string, error) {
	dir, err := os.MkdirTemp("/tmp", fmt.Sprintf("nexus-code-%d-", os.Getuid()))
	if err != nil {
		return "", fmt.Errorf("agentpaths: cannot create a fresh socket directory: %w", err)
	}
	if candidate := filepath.Join(dir, longestName); !SocketPathFits(candidate) {
		_ = os.Remove(dir)
		return "", &SocketPathError{Path: candidate}
	}
	if err := EnsurePrivateDir(dir); err != nil {
		_ = os.Remove(dir)
		return "", err
	}
	return dir, nil
}
