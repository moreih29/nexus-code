package lsp

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func observeServerExit(process *os.Process) bool {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, process.Pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if !errors.Is(err, unix.EINTR) {
			return err == nil
		}
	}
}
