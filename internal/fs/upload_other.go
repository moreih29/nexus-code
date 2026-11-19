//go:build !darwin && !linux

package fs

import (
	"os"
	"path/filepath"
)

func openUploadParent(path string) (*os.File, error) {
	return os.Open(path)
}

func availableUploadSpace(_ *os.File) (*uploadSpace, error) {
	return nil, nil
}

func mkdirUploadAt(dir *os.File, name string) error {
	return os.Mkdir(filepath.Join(dir.Name(), name), 0o777)
}

func sameUploadAt(dir *os.File, name string, file *os.File) bool {
	opened, err := file.Stat()
	if err != nil {
		return false
	}
	named, err := os.Lstat(filepath.Join(dir.Name(), name))
	return err == nil && os.SameFile(opened, named)
}

func removeUploadAt(dir *os.File, name string) error {
	return os.Remove(filepath.Join(dir.Name(), name))
}
