//go:build !windows

package fs

import "syscall"

var errCrossDevice error = syscall.EXDEV
