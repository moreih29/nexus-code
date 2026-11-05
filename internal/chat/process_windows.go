//go:build windows

package chat

import (
	"errors"
	"os"
	"strings"
	"syscall"
)

func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}

// signalTerm ends the program. Windows has no signal to ask it with.
func (p *process) signalTerm() error {
	err := p.cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func (p *process) kill() {
	_ = p.cmd.Process.Kill()
}

// exitPayload translates the program's exit into the chat.exit wire shape.
func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	code := -1
	if err == nil && state != nil {
		code = state.ExitCode()
	}
	return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
}

// sameEnvKey reports whether two variable names name the same variable,
// which on Windows is without regard to case.
func sameEnvKey(a, b string) bool {
	return strings.EqualFold(a, b)
}
