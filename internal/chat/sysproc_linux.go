//go:build linux

package chat

import "syscall"

// newSysProcAttr starts the program in its own process group, killed with
// the agent.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
