//go:build !windows

package hookclient

import (
	"os"
	"os/signal"
	"syscall"
	"time"
)

// forwardedSignals reach claude as they reach the run: the terminal's ^C
// reaches both already, a kill of the run alone does not.
var forwardedSignals = []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT}

// swallowedSignals are caught so that they change nothing: a write to a
// closed output fails rather than end the run before it tells its end.
var swallowedSignals = []os.Signal{syscall.SIGPIPE}

// signalOf is the signal a process died of, by its number and name.
func signalOf(state *os.ProcessState) (int, string, bool) {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return 0, "", false
	}
	sig := status.Signal()
	return int(sig), sig.String(), true
}

// reraise ends this process by signal `n`, as claude ended, where Go lets
// it die of one; the caller exits 128+n otherwise.
func reraise(n int) {
	sig := syscall.Signal(n)
	switch sig {
	case syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP:
		signal.Reset(sig)
		_ = syscall.Kill(os.Getpid(), sig)
		time.Sleep(100 * time.Millisecond)
	}
}

// printStopGrace is how long a run stopped by the app has to end on the
// interrupt before it is terminated.
const printStopGrace = 5 * time.Second

// stopProcess stops a run as the session's ^C would, and terminates it if
// it is still there after printStopGrace. It returns the signal sent.
func stopProcess(p *os.Process) os.Signal {
	if p.Signal(syscall.SIGINT) != nil {
		return nil
	}
	go func() {
		time.Sleep(printStopGrace)
		_ = p.Signal(syscall.SIGTERM)
	}()
	return syscall.SIGINT
}
