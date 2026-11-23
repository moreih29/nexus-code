//go:build linux

package pty

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

func (c *child) hangUp() {}

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
