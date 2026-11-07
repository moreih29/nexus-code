//go:build windows

package chat

import (
	"errors"
	"os"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
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

// holdTree puts the program in a job of its own. A process it starts
// before it is in the job is left out; one that waits on the program's
// input still ends when the input is closed.
func (p *process) holdTree() {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	// What is in the job when it is let go of ends with it. No process may
	// leave it: Git Bash, which runs Claude's commands, starts each program
	// out of any job that lets it.
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false, uint32(p.cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	p.tree.mu.Lock()
	p.tree.job = job
	p.tree.mu.Unlock()
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

// signalTerm ends the program and what it runs. Windows has no signal to
// ask it with.
func (p *process) signalTerm() error {
	if p.endTree() {
		return nil
	}
	err := p.cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func (p *process) kill() {
	if !p.endTree() {
		_ = p.cmd.Process.Kill()
	}
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
