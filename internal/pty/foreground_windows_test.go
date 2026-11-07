//go:build windows

package pty

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
		{pid: 50, parent: 1, name: "bash"},     // Git Bash's launcher
		{pid: 51, parent: 50, name: "bash"},    // the real bash, which ran a script
		{pid: 53, parent: 52, name: "bash"},    // the script, its fork's process gone
		{pid: 54, parent: 53, name: "claude"},  // the program the script runs
		{pid: 60, parent: 1, name: "bash"},     // Git Bash's launcher
		{pid: 61, parent: 60, name: "bash"},    // the real bash, running nothing
		{pid: 70, parent: 1, name: "pwsh"},     // a shell running an npm package's Codex
		{pid: 71, parent: 70, name: "cmd"},     // the package's .cmd
		{pid: 72, parent: 71, name: "node"},    // node on the package's script
		{pid: 73, parent: 72, name: "codex"},   // Codex's own program
		{pid: 74, parent: 73, name: "pwsh"},    // a command Codex runs
		{pid: 80, parent: 1, name: "pwsh"},     // a shell running node
		{pid: 81, parent: 80, name: "node"},    // a script, or an npm package's Claude
		{pid: 82, parent: 81, name: "bash"},    // a command it runs
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
		50: {created: 100, console: true},
		51: {created: 110, console: true},
		53: {created: 130, console: true},
		54: {created: 140, console: true},
		60: {created: 100, console: true},
		61: {created: 110, console: true},
		70: {created: 100, console: true},
		71: {created: 110, console: true},
		72: {created: 120, console: true},
		73: {created: 130, console: true},
		74: {created: 140, console: true},
		80: {created: 100, console: true},
		81: {created: 110, console: true},
		82: {created: 120, console: true},
	}
	detail := func(pid uint32) (processDetail, bool) {
		d, ok := details[pid]
		return d, ok
	}
	// The MSYS runtime's children: of the real bash, the script; the bash
	// running nothing has none.
	msys := func(pid uint32) []uint32 {
		if pid == 51 {
			return []uint32{53}
		}
		return nil
	}
	want := map[uint32]string{10: "claude", 20: "claude", 30: "pwsh", 40: "node", 50: "claude", 60: "bash", 70: "codex", 80: "node", 99: ""}
	for shell, want := range want {
		if got := foregroundOf(entries, shell, detail, msys); got != want {
			t.Errorf("foregroundOf(shell %d) = %q, want %q", shell, got, want)
		}
	}
	if got := foregroundOf(entries, 50, detail, nil); got != "bash" {
		t.Errorf("foregroundOf(shell 50) without the MSYS runtime = %q, want bash", got)
	}
}

func TestMsysChildrenInReadsPsListing(t *testing.T) {
	listing := "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n" +
		"   233062       1  233062      33800  cons6     197609 08:50:32 /usr/bin/bash\n" +
		"I  233154  233062  233154      37576  cons6     197609 08:50:48 /c/Users/kih/.local/bin/claude\n" +
		"   233160  233062  233160      37600  cons6     197609 08:50:49 /usr/bin/sleep\n" +
		"   233170  233154  233170      37700  cons6     197609 08:50:50 /usr/bin/bash\n" +
		"   240000       1  240000      41000  cons7     197609 08:51:00 /usr/bin/bash\n"
	got := msysChildrenIn(listing, 33800)
	if len(got) != 2 || got[0] != 37576 || got[1] != 37600 {
		t.Errorf("children of 33800 = %v, want [37576 37600]", got)
	}
	if got := msysChildrenIn(listing, 41000); len(got) != 0 {
		t.Errorf("children of 41000 = %v, want none", got)
	}
	if got := msysChildrenIn(listing, 12345); got != nil {
		t.Errorf("children of an unlisted process = %v, want nil", got)
	}
}

// TestGitBashReportsTheProgramItsScriptRuns runs a script in Git Bash, whose
// fork and exec leave the script without a Windows parent, as the claude
// and codex wrappers are run.
func TestGitBashReportsTheProgramItsScriptRuns(t *testing.T) {
	bash := filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe")
	if _, err := os.Stat(bash); err != nil {
		t.Skip("Git Bash is not installed")
	}
	svc, rec := newConsoleService(t)
	dir := t.TempDir()
	script := filepath.Join(dir, "wait.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec ping -n 30 127.0.0.1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(SpawnParams{
		WorkspaceID: "ws", TabID: "git-bash", Cwd: dir, Shell: bash, Args: []string{"--norc", "-i"}, Cols: 80, Rows: 24,
	})
	if _, err := svc.Spawn(context.Background(), raw); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	foreground := func() string {
		raw, _ := json.Marshal(ForegroundProcessParams{WorkspaceID: "ws", TabID: "git-bash"})
		result, err := svc.ForegroundProcess(context.Background(), raw)
		if err != nil {
			t.Fatalf("foregroundProcess: %v", err)
		}
		return result.(ForegroundProcessResult).Name
	}
	rec.waitFor(t, "the prompt", func(output string, _ *ExitPayload) bool { return strings.Contains(output, "$") })
	if got := foreground(); !strings.EqualFold(got, "bash") {
		t.Fatalf("idle foreground = %q, want bash", got)
	}
	write := func(data string) {
		raw, _ := json.Marshal(WriteParams{WorkspaceID: "ws", TabID: "git-bash", Data: data})
		if _, err := svc.Write(context.Background(), raw); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	write("./wait.sh\r")
	deadline := time.Now().Add(15 * time.Second)
	for !strings.EqualFold(foreground(), "ping") {
		if time.Now().After(deadline) {
			t.Fatalf("foreground = %q, want ping", foreground())
		}
		time.Sleep(50 * time.Millisecond)
	}

	// The shell gone before the temporary folder it works in is deleted.
	write("\x03")
	time.Sleep(500 * time.Millisecond)
	write("exit\r")
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
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
