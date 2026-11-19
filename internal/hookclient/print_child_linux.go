package hookclient

import (
	"os/exec"
	"runtime"
	"syscall"
)

// preparePrintChild binds Claude to the thread that starts it. Keep that
// thread alive until the child has been waited for.
func preparePrintChild(cmd *exec.Cmd) (func(), error) {
	runtime.LockOSThread()
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	return runtime.UnlockOSThread, nil
}
