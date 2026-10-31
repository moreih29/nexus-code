//go:build !windows

package fs

import (
	"os"
	"testing"
)

// makeUnreadable writes a file at path that the test cannot open.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root ignores the unreadable file this test relies on")
	}
	must(t, os.WriteFile(path, []byte("x"), 0o000))
}
