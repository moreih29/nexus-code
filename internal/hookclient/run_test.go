package hookclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOversizedHookPayloadIsDrainedWithoutForwarding(t *testing.T) {
	in := bytes.NewReader(make([]byte, 16*1024*1024+4096))
	payload, err := readStdinPayload(in)
	if err == nil || payload != nil {
		t.Fatalf("oversized payload returned %d bytes, %v", len(payload), err)
	}
	if in.Len() != 0 {
		t.Fatalf("%d bytes of the hook's input were not drained", in.Len())
	}
}

type mockServer struct {
	listener   net.Listener
	socketPath string
}

func newMockServer(t *testing.T) *mockServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "nh-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socketPath := filepath.Join(dir, "t.sock")
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("mock server listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	return &mockServer{listener: ln, socketPath: socketPath}
}

func (s *mockServer) serveOnce(handler func(conn net.Conn)) {
	conn, err := s.listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	handler(conn)
}

func setHookEnv(t *testing.T, socketPath, token, workspaceID, tabID string) {
	t.Helper()
	pairs := map[string]string{
		envAgentSocket: socketPath,
		envHookToken:   token,
		envWorkspaceID: workspaceID,
		envTabID:       tabID,
	}
	for k, v := range pairs {
		prev, hadPrev := os.LookupEnv(k)
		if err := os.Setenv(k, v); err != nil {
			t.Fatalf("setenv %s: %v", k, err)
		}
		kk, pp, hp := k, prev, hadPrev
		t.Cleanup(func() {
			if hp {
				_ = os.Setenv(kk, pp)
			} else {
				_ = os.Unsetenv(kk)
			}
		})
	}
}

func clearHookEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{envAgentSocket, envHookToken, envWorkspaceID, envTabID} {
		prev, had := os.LookupEnv(k)
		_ = os.Unsetenv(k)
		kk, pp, hh := k, prev, had
		t.Cleanup(func() {
			if hh {
				_ = os.Setenv(kk, pp)
			}
		})
	}
}

func withStdin(t *testing.T, data []byte) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = orig
		r.Close()
	})
	if _, err := w.Write(data); err != nil {
		t.Fatalf("stdin pipe write: %v", err)
	}
	w.Close()
}

func captureStdout(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = orig })
	return func() string {
		w.Close()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r)
		r.Close()
		return buf.String()
	}
}

func TestRunENVMissing_ExitsZero(t *testing.T) {
	withStdin(t, []byte(`{"test":true}`))
	clearHookEnv(t)

	got := Run([]string{"session-start"})
	if got != 0 {
		t.Errorf("expected exit 0 when ENV missing, got %d", got)
	}
}

func TestRunNDJSON_RoundTrip(t *testing.T) {
	srv := newMockServer(t)

	receivedReq := make(chan hookRequest, 1)
	go srv.serveOnce(func(conn net.Conn) {
		var req hookRequest
		if err := json.NewDecoder(conn).Decode(&req); err != nil {
			fmt.Fprintf(os.Stderr, "mock server decode: %v\n", err)
			return
		}
		receivedReq <- req

		resp := hookResponse{OK: true, Stdout: "HOOK_OK"}
		_ = writeNDJSON(conn, resp)
	})

	setHookEnv(t, srv.socketPath, "test-token", "ws-abc", "tab-123")
	withStdin(t, []byte(`{"session":"data"}`))
	readStdout := captureStdout(t)

	exitCode := Run([]string{"session-start"})

	captured := readStdout()
	if exitCode != 0 {
		t.Errorf("expected exit 0, got %d", exitCode)
	}
	if captured != "HOOK_OK" {
		t.Errorf("expected stdout 'HOOK_OK', got %q", captured)
	}

	select {
	case req := <-receivedReq:
		if req.Type != "hook" {
			t.Errorf("type: want 'hook', got %q", req.Type)
		}
		if req.Token != "test-token" {
			t.Errorf("token: want 'test-token', got %q", req.Token)
		}
		if req.WorkspaceID != "ws-abc" {
			t.Errorf("workspaceId: want 'ws-abc', got %q", req.WorkspaceID)
		}
		if req.TabID != "tab-123" {
			t.Errorf("tabId: want 'tab-123', got %q", req.TabID)
		}
		if req.Subcommand != "session-start" {
			t.Errorf("subcommand: want 'session-start', got %q", req.Subcommand)
		}
	case <-time.After(2 * time.Second):
		t.Error("timed out waiting for server to receive request")
	}
}

func TestRunMarksPrintRuns(t *testing.T) {
	cases := []struct {
		name, mark, entrypoint string
		want                   bool
	}{
		{"wrapper's mark", "1", "", true},
		{"Claude Code's entrypoint", "", "sdk-cli", true},
		{"interactive", "0", "cli", false},
		{"neither", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newMockServer(t)
			received := make(chan hookRequest, 1)
			go srv.serveOnce(func(conn net.Conn) {
				var req hookRequest
				if err := json.NewDecoder(conn).Decode(&req); err != nil {
					return
				}
				received <- req
				_ = writeNDJSON(conn, hookResponse{OK: true})
			})
			setHookEnv(t, srv.socketPath, "test-token", "ws-abc", "tab-123")
			t.Setenv(envClaudePrint, tc.mark)
			t.Setenv(envClaudeEntrypoint, tc.entrypoint)
			withStdin(t, []byte(`{"tool_name":"Write"}`))

			if code := Run([]string{"permission-request"}); code != 0 {
				t.Fatalf("exit %d, want 0", code)
			}
			select {
			case req := <-received:
				if req.Print != tc.want {
					t.Errorf("print = %v, want %v", req.Print, tc.want)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for the request")
			}
		})
	}
}

func TestRunNDJSON_OkFalse(t *testing.T) {
	srv := newMockServer(t)

	go srv.serveOnce(func(conn net.Conn) {
		var req hookRequest
		_ = json.NewDecoder(conn).Decode(&req)
		resp := hookResponse{OK: false, Error: "token mismatch"}
		_ = writeNDJSON(conn, resp)
	})

	setHookEnv(t, srv.socketPath, "bad-token", "ws-1", "tab-1")
	withStdin(t, []byte(`{}`))

	exitCode := Run([]string{"notification"})
	if exitCode != 1 {
		t.Errorf("expected exit 1 on ok=false, got %d", exitCode)
	}
}

func TestRunNDJSON_ExitCodePropagated(t *testing.T) {
	srv := newMockServer(t)

	exitVal := 42
	go srv.serveOnce(func(conn net.Conn) {
		var req hookRequest
		_ = json.NewDecoder(conn).Decode(&req)
		resp := hookResponse{OK: true, ExitCode: &exitVal}
		_ = writeNDJSON(conn, resp)
	})

	setHookEnv(t, srv.socketPath, "tok", "ws-1", "tab-1")
	withStdin(t, []byte(`{}`))

	exitCode := Run([]string{"stop"})
	if exitCode != 42 {
		t.Errorf("expected exit 42 from exitCode field, got %d", exitCode)
	}
}

func TestRunTimeout_ReturnsOne(t *testing.T) {
	srv := newMockServer(t)

	go srv.serveOnce(func(conn net.Conn) {
		time.Sleep(200 * time.Millisecond)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	exitCode := runWithContext(ctx, srv.socketPath, "tok", "ws-1", "tab-1", "notification", []byte(`{}`))
	if exitCode != 1 {
		t.Errorf("expected exit 1 on timeout, got %d", exitCode)
	}
}
