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

func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, syscall.EWOULDBLOCK):
		return errLockBusy
	case errors.Is(err, syscall.ENOTSUP), errors.Is(err, syscall.EOPNOTSUPP):
		return errLockUnsupported
	}
	return err
}

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
