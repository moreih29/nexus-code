//go:build linux

package pty

import "syscall"

// newSysProcAttr creates PTY child process attributes with Linux parent-death cleanup.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
