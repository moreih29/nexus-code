//go:build windows

package fs

import "golang.org/x/sys/windows"

// errCrossDevice is the error rename reports for a move across volumes.
var errCrossDevice error = windows.ERROR_NOT_SAME_DEVICE
