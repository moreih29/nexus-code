//go:build darwin || linux

package process

import (
	"errors"
	"syscall"
)

// SignalGroup sends signal to the process group whose ID is pid. A group
// that has already exited counts as success.
func SignalGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
