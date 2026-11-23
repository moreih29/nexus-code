//go:build linux

package pty

import (
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func pollableMaster(master *os.File) *os.File {
	newFD := -1
	if err := withFd(master, func(fd int) (err error) {
		newFD, err = unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
		return err
	}); err != nil {
		return master
	}
	if err := unix.SetNonblock(newFD, true); err != nil {
		_ = unix.Close(newFD)
		return master
	}
	pollable := os.NewFile(uintptr(newFD), master.Name())
	if pollable.SetReadDeadline(time.Time{}) != nil {
		_ = pollable.Close()
		_ = withFd(master, func(fd int) error { return unix.SetNonblock(fd, false) })
		return master
	}
	_ = master.Close()
	return pollable
}
