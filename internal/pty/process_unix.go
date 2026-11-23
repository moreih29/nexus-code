//go:build darwin || linux

package pty

import (
	"os"
	"syscall"
	"time"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

const hangupGrace = time.Second

func (s *session) stopChild() (finish func()) {
	s.stopReading()
	select {
	case <-s.exited:
	default:
		s.child.hangUp()
	}
	return func() {
		select {
		case <-s.exited:
		case <-time.After(hangupGrace):
			s.child.killSession()
		}
	}
}

func (c *child) killSession() {
	_ = hostproc.SignalGroup(c.Pid, syscall.SIGKILL)
	for pass := 0; pass < 3; pass++ {
		left := sessionProcesses(c.Pid)
		if len(left) == 0 {
			return
		}
		for _, pid := range left {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

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
