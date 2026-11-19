//go:build darwin || linux

package chat

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// ownSession starts a command in a session of its own, out of the
// program's process group, as Claude and Codex start each command.
func ownSession(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// ended waits for the process to end, false when it is still running after
// a few seconds. A process that has ended but is not yet reaped counts as
// ended.
func ended(t *testing.T, pid int) bool {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return true
		}
		out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
		if err != nil || strings.HasPrefix(strings.TrimSpace(string(out)), "Z") {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	return false
}

// ownSessionChild starts a command the fake program runs in a session of
// its own, and returns its pid.
func ownSessionChild(t *testing.T, service *Service, rec *recorder) int {
	t.Helper()
	startFake(t, service, "tab", map[string]string{"NEXUS_CHAT_OWN_SESSION": "1"})
	pid := childPid(t, service, rec)
	if sid, err := unix.Getsid(pid); err != nil || sid != pid {
		t.Fatalf("the command is not in a session of its own: sid %d, %v", sid, err)
	}
	return pid
}

// Stopping a tab's program ends a command it started in a session of its
// own, which its process group does not hold.
func TestStopEndsACommandInASessionOfItsOwn(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	pid := ownSessionChild(t, service, rec)
	if _, err := service.Stop(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !ended(t, pid) {
		t.Fatal("the command outlived its program")
	}
}

// The agent shutting down ends such a command too.
func TestCloseEndsACommandInASessionOfItsOwn(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)

	pid := ownSessionChild(t, service, rec)
	service.Close()
	if !ended(t, pid) {
		t.Fatal("the command outlived the agent's programs")
	}
}

func TestDescendantsOfAProcessWithNone(t *testing.T) {
	if got := descendants(1 << 30); len(got) != 0 {
		t.Fatalf("descendants of a pid no process has = %v", got)
	}
}

// TestStopReapsDetachedToolAfterItsParentExits checks the escalation after
// the shell exits on TERM but its app-owned tool ignores the signal.
func TestStopReapsDetachedToolAfterItsParentExits(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()
	startFake(t, service, "tab", map[string]string{"NEXUS_CHAT_OWN_SESSION": "1", "NEXUS_CHAT_RESIST_TERM": "1"})
	pid := childPid(t, service, rec)
	defer func() { _ = syscall.Kill(pid, syscall.SIGKILL) }()
	rec.waitFor(t, "the child's TERM handler", func(lines []LinePayload, _ []ExitPayload) bool {
		for _, line := range lines {
			if strings.Contains(string(line.Message), "resistant-child-ready") {
				return true
			}
		}
		return false
	})
	if _, err := service.Stop(context.Background(), tabParams("tab")); err != nil {
		t.Fatal(err)
	}
	if !ended(t, pid) {
		t.Fatal("app-owned child survived Stop after its parent exited")
	}
}
