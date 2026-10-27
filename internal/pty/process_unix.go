//go:build darwin || linux

package pty

import (
	"errors"
	"os"
	"syscall"
)

// signalGroup sends signal to the child process group rooted at the shell.
func (c *child) signalGroup(signal syscall.Signal) error {
	err := syscall.Kill(-c.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// exitPayload translates the shell's exit into the PTY exit wire shape.
func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	if err != nil {
		code := 1
		return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		signal := signalName(status.Signal())
		return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: nil, Signal: &signal}
	}
	code := state.ExitCode()
	return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
}

// signalName maps the small set of terminal-relevant POSIX signals to Node names.
func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	default:
		return signal.String()
	}
}
