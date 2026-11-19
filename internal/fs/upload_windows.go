package fs

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func createUploadAt(dir *os.File, name string) (*os.File, error) {
	path := filepath.Join(dir.Name(), name)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Permit rename/unlink while holding the identity of the temporary file.
	handle, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

func publishUploadAt(dir *os.File, temp, target string, _ *os.File, _ os.FileInfo) error {
	// Windows uses inherited ACLs and the Go rename replaces existing files.
	return os.Rename(filepath.Join(dir.Name(), temp), filepath.Join(dir.Name(), target))
}
