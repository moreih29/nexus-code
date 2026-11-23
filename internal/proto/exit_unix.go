//go:build !windows

package proto

import (
	"os"
	"syscall"
)

func ExitStatus(state *os.ProcessState, err error) (code *int, signal *string) {
	if err != nil || state == nil {
		failed := -1
		return &failed, nil
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		name := signalName(status.Signal())
		return nil, &name
	}
	exit := state.ExitCode()
	return &exit, nil
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	default:
		return signal.String()
	}
}
