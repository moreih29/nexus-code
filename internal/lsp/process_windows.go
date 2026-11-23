package lsp

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
	"golang.org/x/sys/windows"
)

func startServerCommand(cmd *exec.Cmd) (func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	job, err := hostproc.AssignJob(cmd.Process.Pid, true)
	if err == nil {
		if err = hostproc.ResumeSuspended(uint32(cmd.Process.Pid)); err != nil {
			_ = windows.CloseHandle(job)
		}
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	return sync.OnceFunc(func() { _ = windows.CloseHandle(job) }), nil
}

func observeServerExit(*os.Process) bool { return false }
