//go:build darwin || linux

package agent_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/hookclient"
	"github.com/nexus-code/nexus-code/internal/hookserver"
)

func TestMain(m *testing.M) {
	if code, handled := hookclient.PrintChildHelper(os.Args[1:]); handled {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

const printWorkerFile = "NEXUS_TEST_PRINT_WORKER_FILE"

func TestPrintWorkerFixture(t *testing.T) {
	if os.Getenv(printWorkerFile) == "" {
		return
	}
	path := os.Getenv("NEXUS_TEST_PRINT_PROGRAM")
	if os.Getenv("NEXUS_TEST_PRINT_CODEX") == "1" {
		os.Exit(hookclient.RunCodexExec([]string{path, "exec", "--ephemeral", "test"}))
	}
	os.Exit(hookclient.RunPrint([]string{path, "-p", "test", "--no-session-persistence"}))
}

func TestPrintFinishesWhileWorkerHoldsOutput(t *testing.T) {
	for _, name := range []string{"claude", "codex"} {
		t.Run(name, func(t *testing.T) {
			dir, err := os.MkdirTemp("/tmp", "nexus-print-test-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			t.Setenv(agentpaths.HomeEnv, dir)
			var srv *hookserver.Server
			ready := make(chan struct{})
			end := make(chan struct{}, 1)
			srv, err = hookserver.New("print-test", func(_ string, payload any) error {
				if event, ok := payload.(hookserver.HookEventPayload); ok && event.Subcommand != "print-watch" {
					if event.Subcommand == "print-end" {
						end <- struct{}{}
					}
					<-ready
					return srv.Respond(event.HookID, hookserver.HookResponse{})
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			close(ready)
			defer srv.Close()

			pidFile := filepath.Join(dir, "worker.pid")
			defer func() {
				data, _ := os.ReadFile(pidFile)
				if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 1 {
					_ = syscall.Kill(pid, syscall.SIGKILL)
				}
			}()
			program := filepath.Join(dir, name)
			script := "#!/bin/sh\n/bin/sleep 30 &\nprintf '%s\\n' \"$!\" > \"$" + printWorkerFile + "\"\nprintf 'done\\n'\n"
			if err := os.WriteFile(program, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv(printWorkerFile, pidFile)
			t.Setenv("NEXUS_TEST_PRINT_PROGRAM", program)
			t.Setenv("NEXUS_TEST_PRINT_CODEX", "0")
			if name == "codex" {
				t.Setenv("NEXUS_TEST_PRINT_CODEX", "1")
			}
			t.Setenv("NEXUS_AGENT_SOCKET", srv.SocketPath())
			t.Setenv("NEXUS_HOOK_TOKEN", srv.Token())
			t.Setenv("NEXUS_WORKSPACE_ID", "workspace")
			t.Setenv("NEXUS_TAB_ID", "terminal")
			t.Setenv("GORACE", "atexit_sleep_ms=0")
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPrintWorkerFixture$")
			cmd.Stderr = os.Stderr
			cmd.WaitDelay = time.Second
			out, err := cmd.Output()
			if err != nil || string(out) != "done\n" {
				t.Fatalf("wrapper output = %q, exit = %v", out, err)
			}
			select {
			case <-end:
			default:
				t.Fatal("print-end did not arrive")
			}
		})
	}
}
