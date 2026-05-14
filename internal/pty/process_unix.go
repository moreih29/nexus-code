//go:build darwin || linux

package pty

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// signalProcessGroup sends signal to the child process group rooted at process.
func signalProcessGroup(process *os.Process, signal syscall.Signal) error {
	if process == nil {
		return nil
	}
	err := syscall.Kill(-process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// exitPayloadFromWait translates exec.Wait results into the PTY exit wire shape.
func exitPayloadFromWait(key tabKey, err error) ExitPayload {
	if err == nil {
		code := 0
		return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signal := signalName(status.Signal())
			return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: nil, Signal: &signal}
		}
		code := exitErr.ExitCode()
		return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
	}

	code := 1
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
