//go:build darwin || linux

package agentrun

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func runSocketDir(preferred, longestName string) string {
	if len(filepath.Join(preferred, longestName)) < maxSunPath {
		return preferred
	}
	hash := sha256.Sum256([]byte(preferred))
	return filepath.Join("/tmp", fmt.Sprintf("nexus-code-%d-%x", os.Getuid(), hash[:8]))
}

func ensurePrivateSocketDir(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm() != 0o700 || !ok || int(stat.Uid) != os.Getuid() {
		return fmt.Errorf("agentrun: socket directory %q must be private and owned by the current user", dir)
	}
	return nil
}
