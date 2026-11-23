//go:build windows

package hookclient

import (
	"os"
	"sync"

	hostproc "github.com/nexus-code/nexus-code/internal/process"

	"golang.org/x/sys/windows"
)

var forwardedSignals = []os.Signal{os.Interrupt}

var swallowedSignals = []os.Signal{}

func signalOf(*os.ProcessState) (int, string, bool) { return 0, "", false }

func reraise(int) {}

type processTree struct {
	mu  sync.Mutex
	job windows.Handle
}

func holdTree(p *os.Process) *processTree {
	job, err := hostproc.AssignJob(p.Pid, false)
	if err != nil {
		return nil
	}
	return &processTree{job: job}
}

func (t *processTree) end() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.job != 0 && windows.TerminateJobObject(t.job, 1) == nil
}

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

func stopProcess(p *os.Process, tree *processTree) os.Signal {
	if tree.end() {
		return os.Kill
	}
	if p.Kill() != nil {
		return nil
	}
	return os.Kill
}
