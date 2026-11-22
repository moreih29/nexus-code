package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runFixture(mode string) int {
	switch mode {
	case "stdin":
		fmt.Fprintf(os.Stderr, "%s|%s|%s", os.Getenv("NEXUS_TAB_ID"), os.Getenv("NEXUS_HOOK_TOKEN"), os.Getenv("CLAUDE_CONFIG_DIR"))
		_, _ = io.Copy(os.Stdout, os.Stdin)
	case "wait":
		if err := os.WriteFile("started", nil, 0o600); err != nil {
			return 1
		}
		time.Sleep(time.Minute)
	case "flood":
		_, _ = io.WriteString(os.Stdout, strings.Repeat("a", runOutputCap/2))
		_, _ = io.WriteString(os.Stderr, strings.Repeat("b", runOutputCap/2+1))
	case "leave-pipe-open":
		cmd := exec.Command(os.Args[0])
		cmd.Env = append(os.Environ(), "CHAT_RUN_FIXTURE=hold-pipe")
		cmd.Stdout = os.Stdout
		if err := cmd.Start(); err != nil {
			return 1
		}
		_ = cmd.Process.Release()
		_, _ = io.WriteString(os.Stdout, "complete result")
	case "hold-pipe":
		time.Sleep(1500 * time.Millisecond)
	}
	return 0
}

func runRequest(t *testing.T, dir, mode string, timeoutMs int) json.RawMessage {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(runParams{
		runID: runID{RunID: "fixture"}, Stdin: "first\n둘째\n",
		ExecParams: ExecParams{Program: self, Cwd: dir, TimeoutMs: timeoutMs, Env: map[string]string{
			"CHAT_RUN_FIXTURE": mode, "NEXUS_TAB_ID": "sent", "CLAUDE_CONFIG_DIR": "selected-profile",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestRunStdinAndExplicitEnvironment(t *testing.T) {
	t.Setenv("NEXUS_HOOK_TOKEN", "inherited")
	value, err := New().Run(context.Background(), runRequest(t, t.TempDir(), "stdin", 0))
	if want := (runResult{ExecResult: ExecResult{Stdout: "first\n둘째\n", Stderr: "||selected-profile"}}); err != nil || value != want {
		t.Fatalf("Run = %#v, %v; want %#v", value, err, want)
	}
}

func TestRunTimeout(t *testing.T) {
	value, err := New().Run(context.Background(), runRequest(t, t.TempDir(), "wait", 40))
	if err != nil || !value.(runResult).TimedOut || value.(runResult).Canceled {
		t.Fatalf("Run = %#v, %v", value, err)
	}
}

func TestCancelRunByID(t *testing.T) {
	svc := New()
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := startWaitingRun(t, svc, ctx, dir)
	other, cancelOther := context.WithCancel(context.Background())
	defer cancelOther()
	for _, call := range []struct {
		ctx  context.Context
		id   string
		want bool
	}{
		{other, "fixture", false},
		{ctx, "other", false},
		{ctx, "fixture", true},
	} {
		got, err := svc.CancelRun(call.ctx, json.RawMessage(`{"runId":"`+call.id+`"}`))
		if err != nil || got != call.want {
			t.Fatalf("CancelRun(%q) = %v, %v; want %v", call.id, got, err, call.want)
		}
	}
	assertCanceled(t, ctx, done)
}

func TestCancelBeforeRunRegisters(t *testing.T) {
	svc := New()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got, err := svc.CancelRun(ctx, json.RawMessage(`{"runId":"fixture"}`))
	if err != nil || got != false {
		t.Fatalf("CancelRun = %v, %v", got, err)
	}
	dir := t.TempDir()
	value, err := svc.Run(ctx, runRequest(t, dir, "wait", 100))
	if err != nil || !value.(runResult).Canceled {
		t.Fatalf("late Run = %#v, %v", value, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "started")); !os.IsNotExist(err) {
		t.Fatalf("canceled run started a process: %v", err)
	}
}

func TestCloseCancelsAndWaitsForRun(t *testing.T) {
	svc := New()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := startWaitingRun(t, svc, ctx, t.TempDir())
	svc.Close()
	svc.mu.Lock()
	active := len(svc.runs)
	svc.mu.Unlock()
	if active != 0 {
		t.Fatal("Close returned before the running process was reaped")
	}
	assertCanceled(t, ctx, done)
}

func startWaitingRun(t *testing.T, svc *Service, ctx context.Context, dir string) <-chan any {
	t.Helper()
	raw := runRequest(t, dir, "wait", 0)
	done := make(chan any, 1)
	go func() {
		value, err := svc.Run(ctx, raw)
		if err != nil {
			done <- err
			return
		}
		done <- value
	}()
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			return done
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("run did not start")
		}
	}
}

func assertCanceled(t *testing.T, ctx context.Context, done <-chan any) {
	t.Helper()
	select {
	case value := <-done:
		if got, ok := value.(runResult); !ok || !got.Canceled || got.TimedOut {
			t.Fatalf("Run = %#v", value)
		}
	case <-ctx.Done():
		t.Fatal("run did not end after cancellation")
	}
}

func TestRunKeepsResultWhenChildHoldsOutputPipe(t *testing.T) {
	value, err := New().Run(context.Background(), runRequest(t, t.TempDir(), "leave-pipe-open", 5_000))
	if want := (runResult{ExecResult: ExecResult{Stdout: "complete result"}}); err != nil || value != want {
		t.Fatalf("Run = %#v, %v; want %#v", value, err, want)
	}
}

func TestRunCombinedOutputCap(t *testing.T) {
	value, err := New().Run(context.Background(), runRequest(t, t.TempDir(), "flood", 0))
	if err != nil {
		t.Fatal(err)
	}
	got := value.(runResult)
	if size := len(got.Stdout) + len(got.Stderr); !got.OutputLimit || size != runOutputCap {
		t.Fatalf("Run outputLimit = %v, size = %d", got.OutputLimit, size)
	}
}
