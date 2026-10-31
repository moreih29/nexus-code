//go:build windows

package fs

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

// makeUnreadable writes a file at path that the test cannot open: Windows
// ignores the mode bits, so the file is held open, shared with no one, until
// the test ends.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	must(t, os.WriteFile(path, []byte("x"), 0o644))
	name, err := windows.UTF16PtrFromString(path)
	must(t, err)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	must(t, err)
	t.Cleanup(func() { _ = windows.CloseHandle(h) })
}
