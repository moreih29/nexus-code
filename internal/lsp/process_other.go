//go:build !darwin && !linux && !windows

package lsp

import (
	"os"
	"os/exec"
	"sync"
)

func startServerCommand(cmd *exec.Cmd) (func(), error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return sync.OnceFunc(func() { _ = cmd.Process.Kill() }), nil
}

func observeServerExit(*os.Process) bool { return false }
