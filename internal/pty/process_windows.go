//go:build windows

package pty

import (
	"errors"
	"os"
	"syscall"
)

func (s *session) stopChild() (finish func()) {
	_ = s.child.signalGroup(syscall.SIGKILL)
	s.stopReading()
	return func() {}
}

func (c *child) signalGroup(syscall.Signal) error {
	err := c.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
