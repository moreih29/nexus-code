//go:build !windows

package chat

import (
	"os"
	"path/filepath"
	"testing"
)

func lockClaudeFile(t *testing.T, path string) {
	t.Helper()
	dir := filepath.Dir(path)
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(dir, 0o755)
		_ = os.Chmod(path, 0o600)
	})
	if file, err := os.Open(path); err == nil {
		file.Close()
		t.Skip("this user reads a file with no permissions")
	}
}
