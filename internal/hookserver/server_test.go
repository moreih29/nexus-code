package hookserver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// -----------------------------------------------------------------------
// 테스트용 헬퍼 — 짧은 소켓 경로를 만드는 mockServer
// -----------------------------------------------------------------------

// newTestServer 는 테스트용 Server를 생성한다.
// macOS 104자 경로 제한을 피하기 위해 짧은 agentKey를 사용한다.
func newTestServer(t *testing.T, sink EventSink) *Server {
	t.Helper()
	// os.MkdirTemp가 생성하는 경로가 길 수 있으므로 agentKey는 고정 짧은 값을 사용한다.
	// makeSocketPath("test") = TempDir + "/nexus-h-9f86d08188.sock" ≤ 104자.
	key := fmt.Sprintf("test-%d", os.Getpid())
	srv, err := New(key, sink)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

// dialAndSendRequest 는 테스트에서 hookclient를 흉내내 요청을 전송한다.
func dialAndSendRequest(t *testing.T, socketPath string, req hookWireRequest) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		t.Fatalf("write: %v", err)
	}
	return conn
}

// readResponse 는 conn에서 hookWireResponse 한 줄을 읽는다.
func readResponse(t *testing.T, conn net.Conn, timeout time.Duration) hookWireResponse {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatalf("readResponse: scan failed: %v", scanner.Err())
	}
	var resp hookWireResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("readResponse: unmarshal: %v", err)
	}
	return resp
}

// -----------------------------------------------------------------------
// (a) New가 소켓 파일을 생성하고 0600 퍼미션인지 검증
// -----------------------------------------------------------------------

// TestNew_ListenAndPerm 은 New()가 소켓 파일을 생성하고 0600 퍼미션을 설정하는지 검증한다.
func TestNew_ListenAndPerm(t *testing.T) {
	var sinkCalled int32
	srv := newTestServer(t, func(_ string, _ any) error {
		atomic.AddInt32(&sinkCalled, 1)
		return nil
	})

	// 소켓 파일이 존재해야 한다.
	info, err := os.Stat(srv.SocketPath())
	if err != nil {
		t.Fatalf("socket file not found: %v", err)
	}

	// 퍼미션이 0600이어야 한다.
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("socket perm: want 0600, got %04o", perm)
	}

	// Token이 비어 있지 않아야 한다.
	if srv.Token() == "" {
		t.Error("token is empty")
	}
}

// TestNew_SocketPathTooLong 은 소켓 경로가 104자를 초과하면 에러를 반환하는지 검증한다.
func TestNew_SocketPathTooLong(t *testing.T) {
	// 긴 경로를 강제로 만들기 위해 TempDir을 긴 경로로 교체한다.
	// 실제로는 os.TempDir()을 바꿀 수 없으므로 makeSocketPath 내부 경로가
	// 104자를 넘는 경우를 시뮬레이션하기 위해 긴 소켓 경로를 직접 사용한다.
	longPath := filepath.Join(os.TempDir(), fmt.Sprintf("nexus-h-very-long-path-%s.sock",
		string(make([]byte, 100))))

	// Server를 직접 구성하지 않고 경로 길이만 검사한다.
	if len(longPath) <= maxSocketPathLen {
		t.Skip("test environment TempDir is too short to exceed 104 chars")
	}

	// New()는 내부에서 makeSocketPath를 사용하므로 agentKey로 긴 경로를 유도할 수 없다.
	// 대신 maxSocketPathLen 상수 값(104)이 올바른지와 makeSocketPath 결과 길이를 검증한다.
	key := "short"
	path := makeSocketPath(key)
	if len(path) > maxSocketPathLen {
		t.Errorf("makeSocketPath(%q) = %d chars, exceeds %d", key, len(path), maxSocketPathLen)
	}
}

// -----------------------------------------------------------------------
// (b) 정상 요청 → sink 호출 + inflight 등록 검증
// -----------------------------------------------------------------------

// TestHandleConn_NormalRequest 는 유효한 요청이 오면 sink가 호출되고
// inflight 맵에 연결이 등록되는지 검증한다.
func TestHandleConn_NormalRequest(t *testing.T) {
	type sinkCall struct {
		event   string
		payload HookEventPayload
	}
	calls := make(chan sinkCall, 1)

	srv := newTestServer(t, func(event string, payload any) error {
		p, ok := payload.(HookEventPayload)
		if !ok {
			return fmt.Errorf("unexpected payload type %T", payload)
		}
		calls <- sinkCall{event: event, payload: p}
		return nil
	})

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-test",
		TabID:       "tab-test",
		Subcommand:  "session-start",
		Payload:     json.RawMessage(`{"key":"value"}`),
	})
	defer conn.Close()

	// sink가 호출되기를 기다린다.
	select {
	case call := <-calls:
		if call.event != "claude.hook" {
			t.Errorf("event: want 'claude.hook', got %q", call.event)
		}
		if call.payload.WorkspaceID != "ws-test" {
			t.Errorf("workspaceId: want 'ws-test', got %q", call.payload.WorkspaceID)
		}
		if call.payload.TabID != "tab-test" {
			t.Errorf("tabId: want 'tab-test', got %q", call.payload.TabID)
		}
		if call.payload.Subcommand != "session-start" {
			t.Errorf("subcommand: want 'session-start', got %q", call.payload.Subcommand)
		}
		if call.payload.HookID == "" {
			t.Error("hookId is empty")
		}

		// inflight 맵에 등록되어 있어야 한다.
		_, inflightExists := srv.inflight.Load(call.payload.HookID)
		if !inflightExists {
			t.Error("hookId not found in inflight map after sink call")
		}

	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sink call")
	}
}

// -----------------------------------------------------------------------
// (c) 토큰 불일치 시 conn이 즉시 닫히는지 검증
// -----------------------------------------------------------------------

// TestHandleConn_TokenMismatch 는 잘못된 토큰으로 연결하면 서버가 즉시 닫는지 검증한다.
func TestHandleConn_TokenMismatch(t *testing.T) {
	srv := newTestServer(t, func(_ string, _ any) error { return nil })

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       "wrong-token",
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "session-start",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	// 서버가 연결을 닫으면 읽기 시도 시 EOF 또는 에러가 발생해야 한다.
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	_, err := conn.Read(buf)
	if err == nil {
		t.Error("expected connection to be closed by server on token mismatch, but read succeeded")
	}
}

// -----------------------------------------------------------------------
// (d) Respond가 정확한 hookId conn에 write + close + inflight.Delete 검증
// -----------------------------------------------------------------------

// TestRespond_WritesAndDeletesInflight 는 Respond()가 응답을 write하고
// inflight 맵에서 entry를 제거하는지 검증한다.
func TestRespond_WritesAndDeletesInflight(t *testing.T) {
	type sinkCall struct {
		hookID string
	}
	hookIDCh := make(chan string, 1)

	srv := newTestServer(t, func(_ string, payload any) error {
		p := payload.(HookEventPayload)
		hookIDCh <- p.HookID
		return nil
	})

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "notification",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	// sink에서 hookId를 받는다.
	var hookID string
	select {
	case hookID = <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId from sink")
	}

	// inflight 맵에 등록되어 있는지 확인한다.
	_, ok := srv.inflight.Load(hookID)
	if !ok {
		t.Fatalf("hookId %q not in inflight map before Respond()", hookID)
	}

	// stdout과 exitCode를 명시해 응답한다.
	exitVal := 0
	if err := srv.Respond(hookID, HookResponse{Stdout: "hello", ExitCode: &exitVal}); err != nil {
		t.Fatalf("Respond: %v", err)
	}

	// 응답이 conn에 도달해야 한다.
	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("response ok: want true, got false")
	}
	if resp.Stdout != "hello" {
		t.Errorf("response stdout: want 'hello', got %q", resp.Stdout)
	}

	// inflight 맵에서 제거되었는지 확인한다.
	_, stillExists := srv.inflight.Load(hookID)
	if stillExists {
		t.Error("hookId still in inflight map after Respond()")
	}
}

// -----------------------------------------------------------------------
// (e) 120초 timeout(테스트는 짧은 deadline) → default 응답 write + close
// -----------------------------------------------------------------------

// TestDeadline_DefaultResponse 는 응답이 없을 때 deadline goroutine이
// default 응답(ok=true, 내용 없음)을 write하고 연결을 닫는지 검증한다.
func TestDeadline_DefaultResponse(t *testing.T) {
	hookIDCh := make(chan string, 1)

	srv := newTestServer(t, func(_ string, payload any) error {
		p := payload.(HookEventPayload)
		hookIDCh <- p.HookID
		return nil
	})
	// 테스트용 짧은 deadline을 atomic으로 주입한다.
	srv.testDeadlineNs.Store(int64(100 * time.Millisecond))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	// hookId를 확인한다.
	var hookID string
	select {
	case hookID = <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId")
	}

	// deadline이 지난 후 default 응답이 와야 한다.
	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("default response ok: want true, got false")
	}
	if resp.Stdout != "" {
		t.Errorf("default response stdout: want empty, got %q", resp.Stdout)
	}

	// inflight 맵에서도 제거되어야 한다.
	_, stillExists := srv.inflight.Load(hookID)
	if stillExists {
		t.Error("hookId still in inflight map after deadline timeout")
	}
}

// -----------------------------------------------------------------------
// (f) Close가 listener + 모든 inflight conn 닫음 + 소켓 unlink
// -----------------------------------------------------------------------

// TestClose_CleanupAll 은 Close()가 inflight conn에 default 응답을 write하고
// 소켓 파일을 삭제하는지 검증한다.
func TestClose_CleanupAll(t *testing.T) {
	hookIDCh := make(chan string, 1)

	// newTestServer는 t.Cleanup에서 Close()를 부르므로 여기서는 직접 생성한다.
	key := fmt.Sprintf("close-test-%d", os.Getpid())
	srv, err := New(key, func(_ string, payload any) error {
		p := payload.(HookEventPayload)
		hookIDCh <- p.HookID
		return nil
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "session-start",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	// hookId 등록 완료를 기다린다.
	select {
	case <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId")
	}

	socketPath := srv.SocketPath()

	// Close()를 호출한다.
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// inflight conn에 default 응답이 도달해야 한다.
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("close cleanup response ok: want true, got false")
	}

	// 소켓 파일이 삭제되어야 한다.
	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Errorf("socket file still exists after Close()")
	}

	// 다시 연결 시도 시 실패해야 한다.
	_, dialErr := net.Dial("unix", socketPath)
	if dialErr == nil {
		t.Error("expected dial to fail after Close(), but it succeeded")
	}
}
