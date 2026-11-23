//go:build linux

package main

import "syscall"

func dupStderrToLog(logFd int) error {
	return syscall.Dup3(logFd, 2, 0)
}
