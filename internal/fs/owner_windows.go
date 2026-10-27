//go:build windows

package fs

import (
	"os"

	"golang.org/x/sys/windows"
)

// needsInPlaceWrite reports whether the file at abs has other hard links,
// which a replacement would leave holding the old content: such a file is
// truncated and written in place instead. A Windows file has no POSIX owner
// for the replacement to lose.
func needsInPlaceWrite(abs string, _ os.FileInfo) bool {
	f, err := os.Open(abs)
	if err != nil {
		return false
	}
	defer f.Close()
	var data windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &data); err != nil {
		return false
	}
	return data.NumberOfLinks > 1
}

// keepGroup does nothing: a Windows file has no POSIX group.
func keepGroup(string, os.FileInfo) {}
