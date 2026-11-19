//go:build !darwin && !linux

package fs

import (
	"os"
	"path/filepath"
	"time"
)

func openUploadParent(path string) (*os.File, error) {
	return os.Open(path)
}

func openUploadListing(dir *os.File) (*os.File, error) {
	return os.Open(dir.Name())
}

func removeStaleUploadAt(dir *os.File, name string, cutoff time.Time) {
	info, err := os.Lstat(filepath.Join(dir.Name(), name))
	if err != nil || !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
		return
	}
	opened, err := dir.Stat()
	if err != nil {
		return
	}
	current, err := os.Stat(dir.Name())
	if err == nil && os.SameFile(opened, current) {
		_ = removeUploadAt(dir, name)
	}
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
