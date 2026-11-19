package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"
)

const execTreeFixtureEnv = "NEXUS_TEST_CHAT_EXEC_TREE"

// runExecTreeFixture leaves a helper holding both output pipes. The test
// keeps a connection to it and can detect whether it survived the launcher.
func runExecTreeFixture(address string) int {
	if len(os.Args) > 1 && os.Args[1] == "--tree-helper" {
		conn, err := net.Dial("tcp", address)
		if err != nil {
			return 1
		}
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
		return 0
	}
	cmd := exec.Command(os.Args[0], "--tree-helper")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return 1
	}
	defer cmd.Process.Release()
	time.Sleep(time.Minute)
	return 0
}

// TestExecCancelsOnlyOwnedProcessTrees checks explicit cleanup while leaving
// the background task available after its launcher has gone.
func TestExecCancelsOnlyOwnedProcessTrees(t *testing.T) {
	for _, tc := range []struct {
		name, flag string
		detached   bool
	}{
		{"foreground", "--version", false},
		{"background", "--bg", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			params, err := json.Marshal(ExecParams{
				Program: os.Args[0], Cwd: t.TempDir(), Args: []string{tc.flag},
				Env: map[string]string{execTreeFixtureEnv: listener.Addr().String()},
			})
			if err != nil {
				t.Fatal(err)
			}
			type result struct {
				value any
				err   error
			}
			done := make(chan result, 1)
			go func() {
				value, err := New().Exec(ctx, params)
				done <- result{value, err}
			}()
			_ = listener.SetDeadline(time.Now().Add(5 * time.Second))
			helper, err := listener.AcceptTCP()
			if err != nil {
				t.Fatal("launcher did not start its child:", err)
			}
			defer helper.Close()
			cancel()
			select {
			case got := <-done:
				if got.err != nil || !got.value.(ExecResult).TimedOut {
					t.Fatalf("canceled exec returned %+v", got)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("chat.exec did not finish after cancellation")
			}
			_ = helper.SetDeadline(time.Now().Add(2 * time.Second))
			if tc.detached {
				if _, err := helper.Write([]byte("x")); err != nil {
					t.Fatal(err)
				}
				if _, err := io.ReadFull(helper, make([]byte, 1)); err != nil {
					t.Fatal("detached child exited with the launcher:", err)
				}
			} else if _, err := helper.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
				t.Fatalf("owned child did not exit with its launcher: %v", err)
			}
		})
	}
}
