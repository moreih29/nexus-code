//go:build windows

package chat

import (
	"context"
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

// ownSession leaves a command in the program's job: Windows has no
// sessions to start it out of the program's reach.
func ownSession(*exec.Cmd) {}

// ended waits for the process to end, false when it is still running after
// a few seconds.
func ended(t *testing.T, pid int) bool {
	t.Helper()
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return true
	}
	defer windows.CloseHandle(process)
	if event, _ := windows.WaitForSingleObject(process, 5000); event == windows.WAIT_OBJECT_0 {
		return true
	}
	_ = windows.TerminateProcess(process, 1)
	return false
}

// Stopping a tab's program ends the commands it runs, as its process group
// does on Unix.
func TestStopEndsTheCommandsTheProgramRuns(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	pid := childPid(t, service, rec)
	if _, err := service.Stop(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !ended(t, pid) {
		t.Fatal("the command outlived its program")
	}
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
}

// What a program leaves running when it exits ends with it.
func TestExitEndsTheCommandsTheProgramLeft(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	pid := childPid(t, service, rec)
	if err := send(t, service, "tab", "exit"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
	if !ended(t, pid) {
		t.Fatal("the command outlived its program")
	}
}
