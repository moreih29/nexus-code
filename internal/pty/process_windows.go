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

func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	code := 1
	if err == nil {
		code = state.ExitCode()
	}
	return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
}
