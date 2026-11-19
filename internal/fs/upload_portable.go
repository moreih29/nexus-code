//go:build !darwin && !linux && !windows

package fs

import (
	"os"
	"path/filepath"
)

func createUploadAt(dir *os.File, name string) (*os.File, error) {
	return os.OpenFile(filepath.Join(dir.Name(), name), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
}

func publishUploadAt(dir *os.File, temp, target string, _ *os.File, _ os.FileInfo) error {
	return os.Rename(filepath.Join(dir.Name(), temp), filepath.Join(dir.Name(), target))
}
