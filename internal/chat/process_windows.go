//go:build windows

package chat

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"

	"golang.org/x/sys/windows"
)

func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
}

type tree struct {
	mu  sync.Mutex
	job windows.Handle
}

func (p *process) holdTree() error {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	pid := p.cmd.Process.Pid
	job, err := hostproc.AssignJob(pid, true)
	if err != nil {
		return fmt.Errorf("assign chat process to job: %w", err)
	}
	if err := hostproc.ResumeSuspended(uint32(pid)); err != nil {
		_ = windows.CloseHandle(job)
		return fmt.Errorf("resume chat process: %w", err)
	}
	p.tree.job = job
	return nil
}

func (p *process) releaseTree() {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	if p.tree.job != 0 {
		_ = windows.CloseHandle(p.tree.job)
		p.tree.job = 0
	}
}

func (p *process) endTree() bool {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	return p.tree.job != 0 && windows.TerminateJobObject(p.tree.job, 1) == nil
}

func (p *process) signalTerm() error {
	return p.signalKill()
}

func (p *process) signalKill() error {
	if p.endTree() {
		return nil
	}
	return p.cmd.Process.Kill()
}

func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	code := -1
	if err == nil && state != nil {
		code = state.ExitCode()
	}
	return ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID, Code: &code}
}

func sameEnvKey(a, b string) bool {
	return strings.EqualFold(a, b)
}
