//go:build darwin || linux

package pty

import (
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
