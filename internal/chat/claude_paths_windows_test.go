package chat

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestClaudeLookupsFollowNoJunction(t *testing.T) {
	claudeLookupsFollowNoLink(t, symlinkOrSkip, func(t *testing.T, target, link string) {
		junction(t, link, target)
	})
}

func lockClaudeFile(t *testing.T, path string) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(handle) })
	if file, err := os.Open(path); err == nil {
		file.Close()
		t.Fatal("a locked file was opened")
	}
}
