//go:build !windows

package agentrun

import (
	"errors"
	"os"
	"syscall"
)

var (
	errLockBusy        = errors.New("agentrun: lock held by another process")
	errLockUnsupported = errors.New("agentrun: file system does not support locks")
)

// lockFile takes an exclusive, non-blocking flock(2) on f, released when f is
// closed.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	switch {
	case err == nil:
		return nil
	// EWOULDBLOCK / EAGAIN means another process holds the lock.
	// Both errno values may appear depending on OS.
	case errors.Is(err, syscall.EWOULDBLOCK):
		return errLockBusy
	// ENOTSUP / EOPNOTSUPP: flock not supported on this file system.
	case errors.Is(err, syscall.ENOTSUP), errors.Is(err, syscall.EOPNOTSUPP):
		return errLockUnsupported
	}
	return err
}

// processAlive reports whether pid is a running process. kill(pid, 0) tests
// that without sending a signal; ESRCH means no such process.
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
