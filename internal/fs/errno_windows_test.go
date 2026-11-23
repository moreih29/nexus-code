//go:build windows

package fs

import "golang.org/x/sys/windows"

var errCrossDevice error = windows.ERROR_NOT_SAME_DEVICE
