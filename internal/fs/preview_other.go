//go:build !darwin && !linux && !windows

package fs

import "os"

func openPreviewFile(real string) (*os.File, error) {
	return nil, os.ErrInvalid
}

func previewFileStamp(file *os.File, info os.FileInfo, versioned bool) (previewStamp, bool) {
	return previewStamp{}, false
}

func openProtectedDirectory(real string) (*os.File, error) {
	return nil, os.ErrInvalid
}

func protectedEntrySize(dir *os.File, name string) *int64 {
	return nil
}
