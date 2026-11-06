//go:build darwin || linux

package chat

import (
	"errors"
	"os"
	"syscall"
)

// tree is nothing of its own on Unix: the program's process group holds
// the commands it runs.
type tree struct{}

func (p *process) holdTree()    {}
func (p *process) releaseTree() {}

// signalTerm asks the program's process group to exit: the program and the
// commands it runs.
func (p *process) signalTerm() error {
	return signalGroup(p.cmd.Process.Pid, syscall.SIGTERM)
}

// kill kills the program's process group.
func (p *process) kill() {
	_ = signalGroup(p.cmd.Process.Pid, syscall.SIGKILL)
}

func signalGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// exitPayload translates the program's exit into the chat.exit wire shape.
func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	payload := ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID}
	if err != nil || state == nil {
		code := -1
		payload.Code = &code
		return payload
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		signal := signalName(status.Signal())
		payload.Signal = &signal
		return payload
	}
	code := state.ExitCode()
	payload.Code = &code
	return payload
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	default:
		return signal.String()
	}
}

// sameEnvKey reports whether two variable names name the same variable.
func sameEnvKey(a, b string) bool {
	return a == b
}
