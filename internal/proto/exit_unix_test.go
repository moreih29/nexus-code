//go:build !windows

package proto

import (
	"os/exec"
	"syscall"
	"testing"
)

func TestExitStatusNamesTheSignal(t *testing.T) {
	cmd := exec.Command("sh", "-c", "kill -QUIT $$")
	_ = cmd.Run()
	code, signal := ExitStatus(cmd.ProcessState, nil)
	if code != nil || signal == nil || *signal != "SIGQUIT" {
		t.Fatalf("code %v, signal %v", code, signal)
	}
	if got := signalName(syscall.SIGUSR1); got == "" {
		t.Fatal("an unnamed signal has no name")
	}
}
