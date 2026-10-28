//go:build !windows

package fs

import (
	"errors"
	"syscall"
)

func isNoSpace(err error) bool {
	return errors.Is(err, syscall.ENOSPC)
}

func isCrossDevice(err error) bool {
	return errors.Is(err, syscall.EXDEV)
}

func isNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY)
}
