//go:build darwin

package main

import "syscall"

func dupStderrToLog(logFd int) error {
	return syscall.Dup2(logFd, 2)
}
