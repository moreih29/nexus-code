//go:build darwin || linux

package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/lsp"
)

const workerPIDFileEnv = "NEXUS_TEST_LSP_WORKER_PID_FILE"

func TestLSPWorkerFixture(t *testing.T) {
	path := os.Getenv(workerPIDFileEnv)
	if path == "" {
		return
	}
	worker := exec.Command("/bin/sleep", "30")
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(worker.Process.Pid)), 0600); err != nil {
		_ = worker.Process.Kill()
		t.Fatal(err)
	}
	if os.Getenv("NEXUS_TEST_LSP_STALL") == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(1)
	}
	decoder := lsp.NewDecoder()
	buf := make([]byte, 4096)
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil {
			t.Fatal(err)
		}
		messages, err := decoder.Append(buf[:n])
		if err != nil {
			t.Fatal(err)
		}
		for _, raw := range messages {
			var request struct {
				ID     json.RawMessage
				Method string
			}
			if err := json.Unmarshal(raw, &request); err != nil {
				t.Fatal(err)
			}
			if request.Method == "exit" {
				os.Exit(0)
			}
			if len(request.ID) == 0 {
				continue
			}
			result := any(nil)
			if request.Method == "initialize" {
				result = map[string]any{"capabilities": map[string]any{}}
			}
			frame, err := lsp.EncodeMessage(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stdout.Write(frame); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestLSPCleansUpWorkers(t *testing.T) {
	for _, stall := range []bool{false, true} {
		t.Run(map[bool]string{false: "shutdown", true: "initialize timeout"}[stall], func(t *testing.T) {
			root := t.TempDir()
			pidFile := filepath.Join(root, "worker.pid")
			service := lsp.New()
			defer service.Close()
			t.Cleanup(func() {
				data, _ := os.ReadFile(pidFile)
				if pid, err := strconv.Atoi(string(data)); err == nil && pid > 1 {
					_ = syscall.Kill(pid, syscall.SIGKILL)
				}
			})
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			env := map[string]string{workerPIDFileEnv: pidFile, "GORACE": "atexit_sleep_ms=0"}
			timeout := 5 * time.Second
			if stall {
				env["NEXUS_TEST_LSP_STALL"] = "1"
				timeout = time.Second
			}
			raw, err := json.Marshal(lsp.SpawnParams{
				WorkspaceID: "workspace", LanguageID: "fixture", BinaryPath: exe,
				Args: []string{"-test.run=^TestLSPWorkerFixture$"}, WorkspaceRoot: root, Env: env,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			spawn, err := service.Spawn(ctx, raw)
			switch {
			case stall && !errors.Is(err, context.DeadlineExceeded):
				t.Fatalf("spawn error = %v", err)
			case !stall && err != nil:
				t.Fatalf("spawn error = %v", err)
			case !stall:
				call(t, service.Shutdown, map[string]string{"serverId": spawn.(lsp.SpawnResult).ServerID})
			}
			pid, err := os.ReadFile(pidFile)
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				state, err := exec.Command("ps", "-o", "stat=", "-p", string(pid)).Output()
				if err != nil || strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
					return
				}
				time.Sleep(15 * time.Millisecond)
			}
			t.Fatalf("LSP worker %s still running", pid)
		})
	}
}
