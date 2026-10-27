//go:build windows

package pty

import (
	"errors"
	"os"
	"syscall"
)

// signalGroup terminates the shell. Windows has no signals to send it, so it
// is terminated whatever signal is asked for. The processes the shell started
// in its console end with the console: stop closes the terminal first.
func (c *child) signalGroup(syscall.Signal) error {
	err := c.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

// exitPayload translates the shell's exit into the PTY exit wire shape.
// Windows reports an exit code only, never a signal.
func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	code := 1
	if err == nil {
		code = state.ExitCode()
	}
	return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
}
