//go:build linux

package pty

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// hangUp is done by closing the master: Linux hangs the terminal up then,
// sending its session leader, the shell, SIGHUP and SIGCONT.
func (c *child) hangUp() {}

// sessionProcesses lists the processes in session sid but its leader, as
// /proc shows them.
func sessionProcesses(sid int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	self := os.Getpid()
	var pids []int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == sid || pid == self {
			continue
		}
		if got, err := unix.Getsid(pid); err == nil && got == sid {
			pids = append(pids, pid)
		}
	}
	return pids
}
