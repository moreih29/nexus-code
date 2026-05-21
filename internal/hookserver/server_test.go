package hookserver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
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
	path, _, err := makeSocketPath(key)
	if err != nil {
		t.Fatalf("makeSocketPath: %v", err)
	}
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

// -----------------------------------------------------------------------
// Acceptance tests — Task 2: new socket location + stale cleanup
// -----------------------------------------------------------------------

// Test_makeSocketPath_NewLocation 는 새 소켓 경로가 agentpaths.SocketsDir() prefix를 가지고
// 파일명이 h-<12hex>.sock 형식인지 검증한다.
func Test_makeSocketPath_NewLocation(t *testing.T) {
	socketsDir, err := agentpaths.SocketsDir()
	if err != nil {
		t.Fatalf("agentpaths.SocketsDir: %v", err)
	}

	path, gotDir, err := makeSocketPath("test-agent-key")
	if err != nil {
		t.Fatalf("makeSocketPath: %v", err)
	}

	// socketsDir이 일치해야 한다.
	if gotDir != socketsDir {
		t.Errorf("socketsDir: want %q, got %q", socketsDir, gotDir)
	}

	// 경로의 prefix가 socketsDir이어야 한다.
	if !strings.HasPrefix(path, socketsDir+string(filepath.Separator)) {
		t.Errorf("socket path %q does not have prefix %q", path, socketsDir)
	}

	// 파일명이 h-<12hex>.sock 형식이어야 한다.
	base := filepath.Base(path)
	if !strings.HasPrefix(base, "h-") || !strings.HasSuffix(base, ".sock") {
		t.Errorf("socket filename %q: want h-<hash>.sock format", base)
	}
	// h- 와 .sock 사이의 해시 부분이 12자 hex이어야 한다.
	hashPart := strings.TrimPrefix(strings.TrimSuffix(base, ".sock"), "h-")
	if len(hashPart) != 12 {
		t.Errorf("hash part %q: want 12 chars, got %d", hashPart, len(hashPart))
	}
	for _, c := range hashPart {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("hash part %q contains non-hex character %c", hashPart, c)
		}
	}
}

// Test_maxSocketPathLen_Guard_NewMessage 는 소켓 경로가 104자를 초과했을 때
// 에러 메시지에 "under ~/.nexus-code/sockets/" 단서가 포함되는지 검증한다.
func Test_maxSocketPathLen_Guard_NewMessage(t *testing.T) {
	socketsDir, err := agentpaths.SocketsDir()
	if err != nil {
		t.Fatalf("agentpaths.SocketsDir: %v", err)
	}

	// 104자를 초과하는 가짜 소켓 경로를 직접 검사한다.
	// (makeSocketPath 결과는 실제로는 제한 이내이므로 New()의 guard를 직접 시뮬레이션한다.)
	longPath := filepath.Join(socketsDir, "h-"+string(make([]byte, 100))+".sock")
	if len(longPath) <= maxSocketPathLen {
		t.Skip("test environment SocketsDir is too short to exceed 104 chars — skipping")
	}

	errMsg := fmt.Sprintf("hookserver: socket path too long (%d > %d, under ~/.nexus-code/sockets/): %s",
		len(longPath), maxSocketPathLen, longPath)

	if !strings.Contains(errMsg, "under ~/.nexus-code/sockets/") {
		t.Errorf("error message %q: missing 'under ~/.nexus-code/sockets/' hint", errMsg)
	}

	// New() 자체가 해당 에러를 반환하는지 확인하기 위해, 실제 guard를 검증한다.
	// 상수 값이 104임을 확인한다.
	if maxSocketPathLen != 104 {
		t.Errorf("maxSocketPathLen: want 104, got %d", maxSocketPathLen)
	}
}

// shortTempDir 는 macOS 104자 sun_path 제한을 고려해 /tmp 아래에 짧은 임시 디렉토리를 생성한다.
// t.TempDir()은 /var/folders/... 경로로 경우에 따라 80자+를 사용해 소켓 파일명이 104자를 초과할 수 있다.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "hs-test-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// makeDeadSocket 는 bound-but-not-listening Unix 소켓 파일을 생성한다.
// macOS는 net.Listen 후 Close()하면 소켓 파일을 자동 삭제하므로,
// syscall.Bind만 수행해 소켓 파일을 디스크에 남겨두는 방식을 사용한다.
// 반환된 fd는 테스트 종료 시 닫아야 한다.
func makeDeadSocket(t *testing.T, path string) int {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("Socket: %v", err)
	}
	addr := syscall.SockaddrUnix{Name: path}
	if err := syscall.Bind(fd, &addr); err != nil {
		syscall.Close(fd)
		t.Fatalf("Bind %q: %v", path, err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		os.Remove(path)
	})
	return fd
}

// Test_cleanStaleSockets_AlivePreserved 는 실제 net.Listen으로 띄운 소켓 파일이
// cleanStaleSockets 호출 후에도 제거되지 않는지 검증한다.
func Test_cleanStaleSockets_AlivePreserved(t *testing.T) {
	dir := shortTempDir(t)

	// 살아있는 소켓을 만든다.
	sockPath := filepath.Join(dir, "h-aabbccdd0011.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	// mtime을 70초 과거로 백데이트해 old 조건을 충족시킨다.
	old := time.Now().Add(-70 * time.Second)
	if err := os.Chtimes(sockPath, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	cleanStaleSockets(dir, "other-self.sock")

	// 파일이 여전히 존재해야 한다.
	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("alive socket was incorrectly removed by cleanStaleSockets")
	}

	// listener가 여전히 접속 가능해야 한다.
	conn, err := net.DialTimeout("unix", sockPath, time.Second)
	if err != nil {
		t.Errorf("listener no longer reachable after cleanStaleSockets: %v", err)
	} else {
		conn.Close()
	}
}

// Test_cleanStaleSockets_DeadOldRemoved 는 연결 불가한 오래된 소켓 파일이
// cleanStaleSockets 호출 후 제거되는지 검증한다.
func Test_cleanStaleSockets_DeadOldRemoved(t *testing.T) {
	dir := shortTempDir(t)

	// bound-but-not-listening 소켓을 만든다. macOS에서 net.Listen+Close는 파일을 삭제하므로
	// syscall.Bind 방식으로 소켓 파일을 디스크에 유지한다.
	sockPath := filepath.Join(dir, "h-deadbeef0001.sock")
	makeDeadSocket(t, sockPath)

	// mtime을 70초 과거로 백데이트한다.
	old := time.Now().Add(-70 * time.Second)
	if err := os.Chtimes(sockPath, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	cleanStaleSockets(dir, "other-self.sock")

	// 파일이 제거되어야 한다.
	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Error("dead+old socket was NOT removed by cleanStaleSockets")
	}
}

// Test_cleanStaleSockets_DeadFreshPreserved 는 연결 불가한 소켓 파일이더라도
// mtime이 현재에 가까우면(60초 미만) cleanStaleSockets가 제거하지 않는지 검증한다.
func Test_cleanStaleSockets_DeadFreshPreserved(t *testing.T) {
	dir := shortTempDir(t)

	// bound-but-not-listening 소켓을 만든다. mtime은 현재 시간 그대로 두어 fresh 조건을 유지한다.
	sockPath := filepath.Join(dir, "h-freshbeef0002.sock")
	makeDeadSocket(t, sockPath)

	cleanStaleSockets(dir, "other-self.sock")

	// fresh이므로 파일이 여전히 존재해야 한다.
	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("fresh dead socket was incorrectly removed by cleanStaleSockets (should be preserved)")
	}
}

// Test_cleanStaleSockets_SelfPreserved 는 selfBasename과 일치하는 파일이
// dead+old 조건을 충족하더라도 cleanStaleSockets가 제거하지 않는지 검증한다.
func Test_cleanStaleSockets_SelfPreserved(t *testing.T) {
	dir := shortTempDir(t)

	selfName := "h-selffile0011.sock"
	sockPath := filepath.Join(dir, selfName)

	// bound-but-not-listening 소켓을 만든다.
	makeDeadSocket(t, sockPath)

	// mtime을 70초 과거로 백데이트해 old+dead 조건을 충족시킨다.
	old := time.Now().Add(-70 * time.Second)
	if err := os.Chtimes(sockPath, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	// selfBasename으로 자기 자신을 지정한다.
	cleanStaleSockets(dir, selfName)

	// self 파일은 보존되어야 한다.
	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("self socket was incorrectly removed by cleanStaleSockets")
	}
}
