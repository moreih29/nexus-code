//go:build !darwin && !linux && !windows

package fs

import "os"

func openPreviewFile(real string, versioned bool) (*os.File, bool, error) {
	return nil, false, os.ErrInvalid
}

func previewFileStamp(file *os.File, info os.FileInfo, versioned bool) (previewStamp, bool) {
	return previewStamp{}, false
}
