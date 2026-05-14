//go:build !linux

package pty

import "syscall"

// newSysProcAttr creates PTY child process attributes for platforms without Pdeathsig.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
