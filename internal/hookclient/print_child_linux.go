package hookclient

import (
	"os/exec"
	"runtime"
	"syscall"
)

func preparePrintChild(cmd *exec.Cmd) (func(), error) {
	runtime.LockOSThread()
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	return runtime.UnlockOSThread, nil
}
