//go:build linux

package main

import "syscall"

// dupStderrToLog points fd 2 at the daemon run-log file descriptor.
//
// linux/arm64 has no dup2 syscall (legacy syscall dropped from the arm64
// ABI), so Go's syscall package only exposes Dup3 there. Dup3 with flags=0
// is equivalent to dup2 except it errors when oldfd == newfd — the daemon
// never passes fd 2 as the log fd, so that corner does not apply.
func dupStderrToLog(logFd int) error {
	return syscall.Dup3(logFd, 2, 0)
}
