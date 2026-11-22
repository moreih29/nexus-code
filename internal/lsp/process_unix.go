//go:build darwin || linux

package lsp

import (
	"os/exec"
	"sync"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

func startServerCommand(cmd *exec.Cmd) (func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return sync.OnceFunc(func() {
		_ = hostproc.SignalGroup(cmd.Process.Pid, syscall.SIGKILL)
	}), nil
}
