//go:build windows

package pty

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The other PTY tests run /bin/sh scripts; these drive cmd.exe in a Windows
// pseudoconsole through the same service calls.

type consoleRecorder struct {
	mu     sync.Mutex
	output strings.Builder
	exit   *ExitPayload
}

func newConsoleService(t *testing.T) (*Service, *consoleRecorder) {
	t.Helper()
	svc := New()
	rec := &consoleRecorder{}
	svc.SetEventSink(func(event string, payload any) error {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		switch p := payload.(type) {
		case DataPayload:
			chunk, err := base64.StdEncoding.DecodeString(p.Chunk)
			if err != nil {
				return err
			}
			// Unacked, as the output here stays far below the high watermark.
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
	raw, err := json.Marshal(SpawnParams{
		WorkspaceID: "ws",
		TabID:       tabID,
		Cwd:         t.TempDir(),
		Shell:       os.Getenv("COMSPEC"),
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

// waitFor polls until cond holds over the recorder, failing after timeout.
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
	// The pause gives the console time to render the echo before cmd exits.
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
	// The typed line echoes back verbatim; only its expansion proves cmd ran it.
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

func TestConsoleKillEndsShell(t *testing.T) {
	svc, rec := newConsoleService(t)
	spawnConsole(t, svc, "killed")

	kill, _ := json.Marshal(KillParams{WorkspaceID: "ws", TabID: "killed"})
	if _, err := svc.Kill(context.Background(), kill); err != nil {
		t.Fatalf("kill: %v", err)
	}
	rec.waitFor(t, "exit", func(_ string, exit *ExitPayload) bool { return exit != nil })
}
