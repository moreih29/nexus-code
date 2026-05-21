package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/hookserver"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// -----------------------------------------------------------------------
// fake hookInfoProvider — readyCh를 직접 제어해 WaitReady 동작을 조종한다.
// -----------------------------------------------------------------------

// fakeHookProvider 는 테스트 전용 hookInfoProvider 구현이다.
// readyCh를 닫으면 WaitReady가 즉시 반환(ready), 닫지 않으면 ctx 취소까지 대기(not-ready).
type fakeHookProvider struct {
	socketPath string
	token      string
	readyCh    chan struct{}
}

func newFakeProvider(socketPath, token string) *fakeHookProvider {
	return &fakeHookProvider{
		socketPath: socketPath,
		token:      token,
		readyCh:    make(chan struct{}),
	}
}

// markReady 는 readyCh를 닫아 WaitReady가 즉시 반환하도록 한다.
func (f *fakeHookProvider) markReady() { close(f.readyCh) }

func (f *fakeHookProvider) WaitReady(ctx context.Context) error {
	select {
	case <-f.readyCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *fakeHookProvider) SocketPath() string { return f.socketPath }
func (f *fakeHookProvider) Token() string      { return f.token }

// -----------------------------------------------------------------------
// Case A — 이미 ready 상태인 hookserver에 hook.getInfo 호출
// -----------------------------------------------------------------------

// TestHookGetInfo_Ready 는 hookserver가 이미 ready 상태일 때 handler가
// socketPath와 token을 담은 map을 반환하는지 검증한다.
func TestHookGetInfo_Ready(t *testing.T) {
	fake := newFakeProvider("/tmp/nexus-test.sock", "abc123token")
	fake.markReady() // 즉시 ready

	handler := newHookGetInfoHandler(fake)
	result, err := handler(context.Background(), json.RawMessage("{}"))
	if err != nil {
		t.Fatalf("handler returned unexpected error: %v", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type: want map[string]any, got %T", result)
	}
	if got := m["socketPath"]; got != "/tmp/nexus-test.sock" {
		t.Errorf("socketPath: want %q, got %q", "/tmp/nexus-test.sock", got)
	}
	if got := m["token"]; got != "abc123token" {
		t.Errorf("token: want %q, got %q", "abc123token", got)
	}
}

// -----------------------------------------------------------------------
// Case B — 실제 hookserver.New()로 생성한 인스턴스(readyCh 이미 close됨)
// -----------------------------------------------------------------------

// TestHookGetInfo_RealServer 는 hookserver.New()가 반환한 실제 *Server 인스턴스로
// hook.getInfo를 호출할 때 SocketPath/Token이 정확히 반환되는지 검증한다.
// New() 내부에서 readyCh를 이미 close하므로 WaitReady는 즉시 반환한다.
func TestHookGetInfo_RealServer(t *testing.T) {
	key := fmt.Sprintf("getinfo-test-%d", os.Getpid())
	srv, err := hookserver.New(key, nil)
	if err != nil {
		t.Fatalf("hookserver.New: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })

	// hookInfoProvider 인터페이스로 래핑한다.
	handler := newHookGetInfoHandler(srv)
	result, err := handler(context.Background(), json.RawMessage("{}"))
	if err != nil {
		t.Fatalf("handler returned unexpected error: %v", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type: want map[string]any, got %T", result)
	}
	if got := m["socketPath"]; got != srv.SocketPath() {
		t.Errorf("socketPath mismatch: want %q, got %q", srv.SocketPath(), got)
	}
	if got := m["token"]; got != srv.Token() {
		t.Errorf("token mismatch: want %q, got %q", srv.Token(), got)
	}
}

// -----------------------------------------------------------------------
// Case C-1 — hooksrv가 nil인 경우 즉시 CodeUnavailable
// -----------------------------------------------------------------------

// TestHookGetInfo_NilServer 는 hookInfoProvider가 nil(hookserver 미시작)일 때
// handler가 CodeUnavailable 에러를 반환하는지 검증한다.
func TestHookGetInfo_NilServer(t *testing.T) {
	handler := newHookGetInfoHandler(nil)
	result, err := handler(context.Background(), json.RawMessage("{}"))
	if result != nil {
		t.Errorf("result: want nil, got %v", result)
	}
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if code := proto.ErrorCode(err); code != proto.CodeUnavailable {
		t.Errorf("error code: want %q, got %q", proto.CodeUnavailable, code)
	}
}

// -----------------------------------------------------------------------
// Case C-2 — readyCh가 닫히지 않은 채 timeout
// -----------------------------------------------------------------------

// TestHookGetInfo_Timeout 은 hookserver가 ready 상태가 되지 않을 때
// 짧은 timeout context를 넘기면 CodeUnavailable 에러가 반환되는지 검증한다.
// 실시간 대기는 50ms 이내로 완료되어야 한다.
func TestHookGetInfo_Timeout(t *testing.T) {
	fake := newFakeProvider("/tmp/nexus-timeout.sock", "tok")
	// markReady를 호출하지 않아 readyCh는 영원히 열려 있다.

	handler := newHookGetInfoHandler(fake)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	result, err := handler(ctx, json.RawMessage("{}"))
	elapsed := time.Since(start)

	if result != nil {
		t.Errorf("result: want nil, got %v", result)
	}
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if code := proto.ErrorCode(err); code != proto.CodeUnavailable {
		t.Errorf("error code: want %q, got %q", proto.CodeUnavailable, code)
	}
	// 실시간 대기가 timeout을 크게 초과하지 않아야 한다(여유 500ms).
	if elapsed > 500*time.Millisecond {
		t.Errorf("handler took too long: %s (want < 500ms)", elapsed)
	}
}
