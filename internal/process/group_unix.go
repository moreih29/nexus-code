//go:build darwin || linux

package process

import (
	"errors"
	"syscall"
)

func SignalGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
