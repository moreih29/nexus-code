//go:build darwin

package pty

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// hangUp sends the shell what a hung-up terminal sends its session leader.
// Closing the master is not enough on macOS: the master is a blocking file,
// and its close waits for the read pending on it, which ends only once the
// shell does (macOS revokes the terminal when its session leader exits).
func (c *child) hangUp() {
	_ = syscall.Kill(c.Pid, syscall.SIGHUP)
	_ = syscall.Kill(c.Pid, syscall.SIGCONT)
}

// sessionProcesses lists the processes in session sid but its leader.
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
