//go:build darwin

package chat

import "syscall"

// newSysProcAttr starts the program in its own process group.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
