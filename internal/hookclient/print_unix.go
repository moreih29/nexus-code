//go:build !windows

package hookclient

import (
	"os"
	"os/signal"
	"syscall"
	"time"
)

var forwardedSignals = []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT}

var swallowedSignals = []os.Signal{syscall.SIGPIPE}

func signalOf(state *os.ProcessState) (int, string, bool) {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return 0, "", false
	}
	sig := status.Signal()
	return int(sig), sig.String(), true
}

func reraise(n int) {
	sig := syscall.Signal(n)
	switch sig {
	case syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP:
		signal.Reset(sig)
		_ = syscall.Kill(os.Getpid(), sig)
		time.Sleep(100 * time.Millisecond)
	}
}

const printStopGrace = 5 * time.Second

type processTree struct{}

func holdTree(*os.Process) *processTree { return nil }

func (*processTree) release() {}

func stopProcess(p *os.Process, _ *processTree) os.Signal {
	if p.Signal(syscall.SIGINT) != nil {
		return nil
	}
	go func() {
		time.Sleep(printStopGrace)
		_ = p.Signal(syscall.SIGTERM)
	}()
	return syscall.SIGINT
}
