//go:build !windows

package fs

import "syscall"

// errCrossDevice is the error rename reports for a move across file systems.
var errCrossDevice error = syscall.EXDEV
