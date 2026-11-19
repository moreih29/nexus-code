//go:build darwin || linux

package pty

import (
	"os"
	"syscall"
	"time"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

// hangupGrace is how long a closed tab's shell has to end on the hangup
// before what is left of its session is killed.
const hangupGrace = time.Second

// stopChild closes the PTY master, which hangs up the shell as closing a
// terminal does: the shell passes SIGHUP on to its jobs and saves its history
// before it ends, and its foreground job gets SIGHUP from the kernel. A shell
// killed at once instead left its background jobs running with no terminal and
// lost the history. What ignores the hangup — a nohup'd job — goes on, as it
// does anywhere.
//
// finish waits for the shell to end. One still running after hangupGrace
// never passed the hangup on, and is killed with all that is left of its
// session.
func (s *session) stopChild() (finish func()) {
	s.stopReading()
	select {
	case <-s.exited:
		// Its pid may be another process's by now.
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

// killSession kills the shell and every process left in its session, which
// the shell leads. Processes started meanwhile are caught by another pass.
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
