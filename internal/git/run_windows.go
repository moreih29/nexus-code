//go:build windows

package git

import (
	"fmt"
	"os/exec"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
	"golang.org/x/sys/windows"
)

func runGitWithOutputLimit(cmd *exec.Cmd, stdout *cappedBuffer) (runErr, cleanupErr error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	jobReady := make(chan struct{})
	var job windows.Handle
	cancel := stdout.cancel
	stdout.cancel = func() {
		<-jobReady
		if job != 0 {
			cleanupErr = hostproc.TerminateJobAndWait(job, cmd.WaitDelay)
			if cleanupErr != nil {
				cleanupErr = fmt.Errorf("terminate Git process tree after stdout overflow: %w", cleanupErr)
			}
		}
		cancel()
	}
	if err := cmd.Start(); err != nil {
		return err, nil
	}
	var err error
	job, err = hostproc.AssignJob(cmd.Process.Pid, false)
	if err == nil {
		defer windows.CloseHandle(job)
		err = hostproc.ResumeSuspended(uint32(cmd.Process.Pid))
	}
	close(jobReady)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return fmt.Errorf("start Git in a job: %w", err), nil
	}

	runErr = cmd.Wait()
	return runErr, cleanupErr
}
