//go:build windows

package fs

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	must(t, os.WriteFile(path, []byte("x"), 0o644))
	name, err := windows.UTF16PtrFromString(path)
	must(t, err)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	must(t, err)
	t.Cleanup(func() { _ = windows.CloseHandle(h) })
}
