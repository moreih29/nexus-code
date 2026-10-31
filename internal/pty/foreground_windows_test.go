//go:build windows

package pty

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestForegroundOfFollowsTheShellsNewestConsoleChild(t *testing.T) {
	entries := []processEntry{
		{pid: 10, parent: 1, name: "powershell"},
		{pid: 11, parent: 10, name: "notepad"}, // a window program
		{pid: 12, parent: 10, name: "old"},     // older than the shell
		{pid: 13, parent: 10, name: "claude"},  // the newest console child
		{pid: 14, parent: 10, name: "lazygit"}, // older than claude
		{pid: 15, parent: 13, name: "bash"},    // claude's hook, not the shell's
		{pid: 20, parent: 1, name: "bash"},     // Git Bash's launcher
		{pid: 21, parent: 20, name: "bash"},    // the real bash
		{pid: 22, parent: 21, name: "bash"},    // a script waiting for its program
		{pid: 23, parent: 22, name: "claude"},  // the program
		{pid: 30, parent: 1, name: "pwsh"},     // a shell running nothing
		{pid: 40, parent: 1, name: "cmd"},      // a shell running a .cmd script
		{pid: 41, parent: 40, name: "cmd"},     // the script's cmd
		{pid: 42, parent: 41, name: "node"},    // the script's program
	}
	details := map[uint32]processDetail{
		10: {created: 100, console: true},
		11: {created: 300, console: false},
		12: {created: 50, console: true},
		13: {created: 200, console: true},
		14: {created: 150, console: true},
		15: {created: 250, console: true},
		20: {created: 100, console: true},
		21: {created: 110, console: true},
		22: {created: 120, console: true},
		23: {created: 130, console: true},
		30: {created: 100, console: true},
		40: {created: 100, console: true},
		41: {created: 110, console: true},
		42: {created: 120, console: true},
	}
	detail := func(pid uint32) (processDetail, bool) {
		d, ok := details[pid]
		return d, ok
	}
	for shell, want := range map[uint32]string{10: "claude", 20: "claude", 30: "pwsh", 40: "node", 99: ""} {
		if got := foregroundOf(entries, shell, detail); got != want {
			t.Errorf("foregroundOf(shell %d) = %q, want %q", shell, got, want)
		}
	}
}

func TestConsoleReportsTheProgramItsShellRuns(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "foreground")
	foreground := func() string {
		raw, _ := json.Marshal(ForegroundProcessParams{WorkspaceID: "ws", TabID: "foreground"})
		result, err := svc.ForegroundProcess(context.Background(), raw)
		if err != nil {
			t.Fatalf("foregroundProcess: %v", err)
		}
		return result.(ForegroundProcessResult).Name
	}
	rec.waitFor(t, "the prompt", func(output string, _ *ExitPayload) bool { return strings.Contains(output, ">") })
	if got := foreground(); !strings.EqualFold(got, "cmd") {
		t.Fatalf("idle foreground = %q, want cmd", got)
	}

	write := func(data string) {
		raw, _ := json.Marshal(WriteParams{WorkspaceID: "ws", TabID: "foreground", Data: data})
		if _, err := svc.Write(context.Background(), raw); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	waitForeground := func(want string) {
		deadline := time.Now().Add(15 * time.Second)
		for !strings.EqualFold(foreground(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("foreground = %q, want %s", foreground(), want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	// About three seconds of ping, then the shell again.
	write("ping -n 4 127.0.0.1\r")
	waitForeground("ping")
	waitForeground("cmd")

	write("exit\r")
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
}
