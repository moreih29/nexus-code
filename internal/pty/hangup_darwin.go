//go:build darwin

package pty

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func (c *child) hangUp() {
	_ = syscall.Kill(c.Pid, syscall.SIGHUP)
	_ = syscall.Kill(c.Pid, syscall.SIGCONT)
}

func sessionProcesses(sid int) []int {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	self := os.Getpid()
	var pids []int
	for _, proc := range procs {
		pid := int(proc.Proc.P_pid)
		if pid <= 0 || pid == sid || pid == self {
			continue
		}
		if got, err := unix.Getsid(pid); err == nil && got == sid {
			pids = append(pids, pid)
		}
	}
	return pids
}
