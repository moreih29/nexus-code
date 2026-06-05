//go:build darwin

package main

import "syscall"

// dupStderrToLog points fd 2 at the daemon run-log file descriptor.
//
// darwin has no dup3; Dup2 is the portable call on this platform.
func dupStderrToLog(logFd int) error {
	return syscall.Dup2(logFd, 2)
}
