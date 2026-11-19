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

// tree is the job object the program runs in. It holds the processes the
// program starts, as its process group does on Unix: ending the program
// alone left them running, as a command Claude ran in the background was
// once its tab closed.
type tree struct {
	mu sync.Mutex
	// job is zero when the program has none, or once it is released.
	job windows.Handle
}

// holdTree assigns the suspended launcher before it can start any children.
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

// releaseTree lets go of the job once the program has exited, which ends
// what it left running.
func (p *process) releaseTree() {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	if p.tree.job != 0 {
		_ = windows.CloseHandle(p.tree.job)
		p.tree.job = 0
	}
}

// endTree ends the program and every process in its job; false when it has
// no job.
func (p *process) endTree() bool {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	return p.tree.job != 0 && windows.TerminateJobObject(p.tree.job, 1) == nil
}

// signalTerm uses the job on Windows, where there is no portable TERM.
func (p *process) signalTerm() error {
	return p.signalKill()
}

// signalKill terminates the job, or the launcher if it was cancelled during
// creation before it was able to join the job.
func (p *process) signalKill() error {
	if p.endTree() {
		return nil
	}
	return p.cmd.Process.Kill()
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
