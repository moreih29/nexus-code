//go:build windows

package fs

import (
	"os"

	"golang.org/x/sys/windows"
)

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

func keepGroup(string, os.FileInfo) {}
