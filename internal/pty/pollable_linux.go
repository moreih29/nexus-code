//go:build linux

package pty

import (
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// pollableMaster returns the PTY master as a non-blocking file registered
// with the Go runtime poller, so that closing it wakes a pending Read.
//
// creack/pty hands back a blocking descriptor (its ioctls go through
// os.File.Fd(), which switches the file to blocking mode), and a blocking
// read on Linux is not interrupted by Close. Linux also does not revoke the
// terminal when the shell exits, so a job-control background job (its own
// process group) that still holds the slave open keeps the master read from
// ever seeing EIO: readLoop never finishes, waitLoop waits for it forever,
// and pty.exit is never sent. macOS revokes the terminal when the session
// leader exits, which is why it keeps the descriptor creack/pty returns.
//
// Best effort: on any failure the original blocking master is returned
// unchanged.
func pollableMaster(master *os.File) *os.File {
	newFD := -1
	if err := withFd(master, func(fd int) (err error) {
		newFD, err = unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
		return err
	}); err != nil {
		return master
	}
	// O_NONBLOCK lives on the open file description, which the duplicate
	// shares with master.
	if err := unix.SetNonblock(newFD, true); err != nil {
		_ = unix.Close(newFD)
		return master
	}
	pollable := os.NewFile(uintptr(newFD), master.Name())
	// Deadlines are only supported on poller-registered files; without the
	// poller a non-blocking read would fail with EAGAIN instead of waiting.
	if pollable.SetReadDeadline(time.Time{}) != nil {
		_ = pollable.Close()
		_ = withFd(master, func(fd int) error { return unix.SetNonblock(fd, false) })
		return master
	}
	_ = master.Close()
	return pollable
}
