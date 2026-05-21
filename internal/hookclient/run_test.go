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

// -----------------------------------------------------------------------
// 헬퍼 — 테스트용 Unix 소켓 mock 서버
// -----------------------------------------------------------------------

// mockServer 는 테스트에서 Unix 도메인 소켓으로 단일 연결을 수락하는 서버다.
type mockServer struct {
	listener   net.Listener
	socketPath string
}

// newMockServer 는 임시 디렉토리에 Unix 소켓 listener를 생성한다.
// macOS는 소켓 경로가 104자로 제한되므로 os.MkdirTemp + 단순 파일명을 사용한다.
func newMockServer(t *testing.T) *mockServer {
	t.Helper()
	// os.TempDir() 기반으로 짧은 경로를 만들어 macOS 104자 한계를 회피한다.
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

// serveOnce 는 연결 1개를 수락해 handler를 실행한다. goroutine에서 호출해야 한다.
func (s *mockServer) serveOnce(handler func(conn net.Conn)) {
	conn, err := s.listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	handler(conn)
}

// -----------------------------------------------------------------------
// ENV 설정 헬퍼
// -----------------------------------------------------------------------

// setHookEnv 는 테스트에 필요한 ENV를 설정하고 cleanup 함수를 등록한다.
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
		// 클로저 변수 캡처를 위한 복사.
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

// clearHookEnv 는 4개의 hook ENV를 모두 해제한다.
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

// -----------------------------------------------------------------------
// stdin 리디렉션 헬퍼
// -----------------------------------------------------------------------

// withStdin 은 테스트 중 os.Stdin을 data를 읽는 파이프로 교체한다.
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

// captureStdout 은 테스트 중 os.Stdout을 파이프로 교체하고,
// cleanup 시 캡처된 내용을 반환하는 함수를 돌려준다.
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

// -----------------------------------------------------------------------
// 테스트 케이스
// -----------------------------------------------------------------------

// TestRunENVMissing_ExitsZero 는 4개 ENV가 모두 비어 있을 때
// Run()이 exit 0을 반환하는지 검증한다.
func TestRunENVMissing_ExitsZero(t *testing.T) {
	withStdin(t, []byte(`{"test":true}`))
	clearHookEnv(t)

	got := Run([]string{"session-start"})
	if got != 0 {
		t.Errorf("expected exit 0 when ENV missing, got %d", got)
	}
}

// TestRunENVPartial_ExitsZero 는 ENV 중 NEXUS_TAB_ID만 없을 때에도
// exit 0을 반환하는지 검증한다.
func TestRunENVPartial_ExitsZero(t *testing.T) {
	withStdin(t, []byte(`{}`))
	clearHookEnv(t)

	_ = os.Setenv(envAgentSocket, "/tmp/dummy.sock")
	_ = os.Setenv(envHookToken, "tok")
	_ = os.Setenv(envWorkspaceID, "ws1")
	// envTabID 는 설정하지 않는다.
	t.Cleanup(func() {
		_ = os.Unsetenv(envAgentSocket)
		_ = os.Unsetenv(envHookToken)
		_ = os.Unsetenv(envWorkspaceID)
	})

	got := Run([]string{"session-start"})
	if got != 0 {
		t.Errorf("expected exit 0 when tabId missing, got %d", got)
	}
}

// TestRunNDJSON_RoundTrip 은 정상 NDJSON 송수신 시나리오를 검증한다:
// (1) hookclient가 요청 프레임을 올바른 형식으로 송신한다.
// (2) agent 응답 ok=true·stdout="HOOK_OK" 를 받으면 stdout에 기록하고 exit 0을 반환한다.
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

// TestRunNDJSON_OkFalse 는 agent가 ok=false를 반환할 때 exit 1을 반환하는지 검증한다.
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

// TestRunNDJSON_ExitCodePropagated 는 응답에 exitCode가 명시되면 그 값을
// 그대로 반환하는지 검증한다.
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

// TestRunTimeout_ReturnsOne 은 서버가 응답을 보내지 않을 때 timeout 후 exit 1을
// 반환하는지 검증한다. 짧은 timeout context를 직접 사용해 빠르게 확인한다.
func TestRunTimeout_ReturnsOne(t *testing.T) {
	srv := newMockServer(t)

	// 서버는 연결을 수락하지만 곧 닫아버려 응답을 보내지 않는다.
	go srv.serveOnce(func(conn net.Conn) {
		time.Sleep(200 * time.Millisecond)
		// conn.Close()는 defer에서 처리됨.
	})

	// runWithContext를 짧은 timeout으로 직접 호출한다.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	exitCode := runWithContext(ctx, srv.socketPath, "tok", "ws-1", "tab-1", "notification", []byte(`{}`))
	if exitCode != 1 {
		t.Errorf("expected exit 1 on timeout, got %d", exitCode)
	}
}
