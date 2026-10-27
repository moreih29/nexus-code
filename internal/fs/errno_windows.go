//go:build windows

package fs

import (
	"errors"

	"golang.org/x/sys/windows"
)

// The syscall package's ENOSPC, EXDEV and ENOTEMPTY are placeholders on
// Windows, which reports these errors with its own codes.

func isNoSpace(err error) bool {
	return errors.Is(err, windows.ERROR_DISK_FULL) || errors.Is(err, windows.ERROR_HANDLE_DISK_FULL)
}

func isCrossDevice(err error) bool {
	return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE)
}

func isNotEmpty(err error) bool {
	return errors.Is(err, windows.ERROR_DIR_NOT_EMPTY)
}
