//go:build windows

package hookclient

import (
	"os"
	"sync"

	hostproc "github.com/nexus-code/nexus-code/internal/process"

	"golang.org/x/sys/windows"
)

// forwardedSignals: Windows reaches every process of the console with ^C.
var forwardedSignals = []os.Signal{os.Interrupt}

var swallowedSignals = []os.Signal{}

// signalOf: a process on Windows ends with an exit code alone.
func signalOf(*os.ProcessState) (int, string, bool) { return 0, "", false }

func reraise(int) {}

// processTree is the job object a run's program runs in, which holds the
// processes it starts: a node package's codex runs codex itself, and codex
// its commands, which ending the program alone left running.
type processTree struct {
	mu sync.Mutex
	// job is zero once the tree is released.
	job windows.Handle
}

// holdTree puts the program in a job of its own; nil when it cannot. A
// process it starts before it is in the job is left out. What is in the
// job when it is let go of keeps running, as it did before.
func holdTree(p *os.Process) *processTree {
	job, err := hostproc.AssignJob(p.Pid, false)
	if err != nil {
		return nil
	}
	return &processTree{job: job}
}

// end ends every process in the job; false when there is no job.
func (t *processTree) end() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.job != 0 && windows.TerminateJobObject(t.job, 1) == nil
}

// release lets go of the job, leaving what is in it running.
func (t *processTree) release() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		_ = windows.CloseHandle(t.job)
		t.job = 0
	}
}

// stopProcess ends a run and what it started: Windows has no interrupt to
// send one process.
func stopProcess(p *os.Process, tree *processTree) os.Signal {
	if tree.end() {
		return os.Kill
	}
	if p.Kill() != nil {
		return nil
	}
	return os.Kill
}
