//go:build windows

package pty

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type consoleRecorder struct {
	mu     sync.Mutex
	output strings.Builder
	exit   *ExitPayload
}

func newConsoleService(t *testing.T) (*Service, *consoleRecorder) {
	t.Helper()
	svc := New()
	rec := &consoleRecorder{}
	svc.SetEventSink(context.Background(), func(event string, payload any) error {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		switch p := payload.(type) {
		case DataPayload:
			chunk, err := base64.StdEncoding.DecodeString(p.Chunk)
			if err != nil {
				return err
			}
			rec.output.Write(chunk)
		case ExitPayload:
			rec.exit = &p
		}
		return nil
	})
	t.Cleanup(svc.Close)
	return svc, rec
}

func spawnConsole(t *testing.T, svc *Service, tabID string, args ...string) {
	t.Helper()
	spawnProgram(t, svc, tabID, os.Getenv("COMSPEC"), t.TempDir(), args...)
}

func spawnProgram(t *testing.T, svc *Service, tabID, program, cwd string, args ...string) {
	t.Helper()
	raw, err := json.Marshal(SpawnParams{
		WorkspaceID: "ws",
		TabID:       tabID,
		Cwd:         cwd,
		Shell:       program,
		Args:        args,
		Cols:        80,
		Rows:        24,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.Spawn(context.Background(), raw)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if pid := result.(SpawnResult).PID; pid <= 0 {
		t.Fatalf("spawn pid = %d, want > 0", pid)
	}
}

func (r *consoleRecorder) waitFor(t *testing.T, what string, cond func(output string, exit *ExitPayload) bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		ok := cond(r.output.String(), r.exit)
		r.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("timed out waiting for %s; output %q, exit %+v", what, r.output.String(), r.exit)
}

func TestConsoleRunsCommandAndReportsExitCode(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "echo", "/c", "echo nexus-conpty-sentinel & ping -n 2 127.0.0.1 >nul & exit 7")

	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if !strings.Contains(rec.output.String(), "nexus-conpty-sentinel") {
		t.Errorf("output %q lacks the echoed sentinel", rec.output.String())
	}
	if rec.exit.Code == nil || *rec.exit.Code != 7 {
		t.Errorf("exit = %+v, want code 7", rec.exit)
	}
}

func TestConsolePassesArgumentsToGitBashProgramsAsGiven(t *testing.T) {
	printf := filepath.Join(os.Getenv("ProgramFiles"), "Git", "usr", "bin", "printf.exe")
	if _, err := os.Stat(printf); err != nil {
		t.Skip("Git for Windows is not installed")
	}
	cwd := t.TempDir()
	for _, name := range []string{"m1.txt", "m2.txt"} {
		if err := os.WriteFile(filepath.Join(cwd, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	args := []string{`a"b`, "x y", "", `C:\dir with space\`, "it's", "*.txt", "{a,b}", `a\"b`, `tail\`}
	svc, rec := newConsoleService(t)
	spawnProgram(t, svc, "msys", printf, cwd, append([]string{"<%s>"}, args...)...)

	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var want strings.Builder
	for _, arg := range args {
		want.WriteString("<" + arg + ">")
	}
	if !strings.Contains(rec.output.String(), want.String()) {
		t.Errorf("output %q lacks %q", rec.output.String(), want.String())
	}
}

func TestConsoleTakesInputAndResizes(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "interactive")

	resize, _ := json.Marshal(ResizeParams{WorkspaceID: "ws", TabID: "interactive", Cols: 120, Rows: 40})
	if _, err := svc.Resize(context.Background(), resize); err != nil {
		t.Fatalf("resize: %v", err)
	}
	write, _ := json.Marshal(WriteParams{WorkspaceID: "ws", TabID: "interactive", Data: "echo typed-%COMSPEC:~0,1%-input\r"})
	if _, err := svc.Write(context.Background(), write); err != nil {
		t.Fatalf("write: %v", err)
	}
	drive := os.Getenv("COMSPEC")[:1]
	rec.waitFor(t, "command output", func(output string, _ *ExitPayload) bool {
		return strings.Contains(output, "typed-"+drive+"-input")
	})

	write, _ = json.Marshal(WriteParams{WorkspaceID: "ws", TabID: "interactive", Data: "exit 3\r"})
	if _, err := svc.Write(context.Background(), write); err != nil {
		t.Fatalf("write: %v", err)
	}
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.exit.Code == nil || *rec.exit.Code != 3 {
		t.Errorf("exit = %+v, want code 3", rec.exit)
	}
}

func TestConsoleCtrlCStopsTheProgram(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "ctrl-c")
	rec.waitFor(t, "the prompt", func(output string, _ *ExitPayload) bool { return strings.Contains(output, ">") })
	write := func(data string) {
		raw, _ := json.Marshal(WriteParams{WorkspaceID: "ws", TabID: "ctrl-c", Data: data})
		if _, err := svc.Write(context.Background(), raw); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	write("ping -n 30 127.0.0.1 & echo ping-%COMSPEC:~0,1%-done\r")
	time.Sleep(time.Second)
	write("\x03")
	drive := os.Getenv("COMSPEC")[:1]
	deadline := time.Now().Add(10 * time.Second)
	for {
		rec.mu.Lock()
		done := strings.Contains(rec.output.String(), "ping-"+drive+"-done")
		rec.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ping still runs after Ctrl+C")
		}
		time.Sleep(20 * time.Millisecond)
	}
	write("exit\r")
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
}

func TestConsoleKillEndsShell(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "killed")

	kill, _ := json.Marshal(KillParams{WorkspaceID: "ws", TabID: "killed"})
	if _, err := svc.Kill(context.Background(), kill); err != nil {
		t.Fatalf("kill: %v", err)
	}
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
}

func TestMergeEnvOverridesPathWhateverItsCase(t *testing.T) {
	t.Setenv("Path", `C:\Windows`)

	env := mergeEnv(map[string]string{"PATH": `C:\nexus\bin;C:\Windows`})

	var paths []string
	for _, entry := range env {
		if key, _, _ := strings.Cut(entry, "="); strings.EqualFold(key, "PATH") {
			paths = append(paths, entry)
		}
	}
	if len(paths) != 1 || paths[0] != `PATH=C:\nexus\bin;C:\Windows` {
		t.Fatalf("PATH entries = %q, want only the override", paths)
	}
}

func TestMergeEnvKeepsBothCmdLaunchers(t *testing.T) {
	t.Setenv("Path", `C:\Windows`)
	env := mergeEnv(map[string]string{
		wrapperDirEnv:         `C:\Nexus Work\cli`,
		"NEXUS_CMD_CODEX_DIR": `C:\Nexus Work & Notes\cmd!`,
	})
	want := `C:\Nexus Work & Notes\cmd!;C:\Nexus Work\cli;C:\Windows`
	if got := pathValues(env); len(got) != 1 || got[0] != want {
		t.Fatalf("PATH = %q, want [%q]", got, want)
	}
}
