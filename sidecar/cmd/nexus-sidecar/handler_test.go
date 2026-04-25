package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
	"nexus-code/sidecar/internal/wsx"
)

type fakeServer struct {
	mu     sync.Mutex
	sends  []any
	code   int
	reason string
}

func (s *fakeServer) Serve(context.Context) error { return nil }

func (s *fakeServer) Send(_ context.Context, msg any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sends = append(s.sends, msg)
	return nil
}

func (s *fakeServer) Close(code int, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.code = code
	s.reason = reason
	return nil
}

func (s *fakeServer) sentAt(i int) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sends[i]
}

func (s *fakeServer) sentLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sends)
}

func (s *fakeServer) closeState() (int, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.code, s.reason
}

func TestAuthMiddlewareTokenValidation(t *testing.T) {
	handler := wsx.AuthMiddleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name  string
		token string
		want  int
	}{
		{name: "통과", token: "secret", want: http.StatusNoContent},
		{name: "실패", token: "wrong", want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("X-Sidecar-Token", tc.token)
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			if rr.Code != tc.want {
				t.Fatalf("status = %d, want %d", rr.Code, tc.want)
			}
		})
	}
}

func TestSidecarStartCommandSendsStartedEvent(t *testing.T) {
	bootTime := time.Date(2026, 4, 25, 1, 2, 3, 4, time.UTC)
	server := &fakeServer{}
	handler := NewLifecycleHandler("ws-1", bootTime, func(int) {})
	handler.SetServer(server)

	raw := mustJSON(t, contracts.SidecarStartCommand{Type: typeSidecarStartCommand, WorkspaceID: "ws-1"})
	if err := handler.OnMessage(context.Background(), raw); err != nil {
		t.Fatalf("OnMessage() error = %v", err)
	}

	if got := server.sentLen(); got != 1 {
		t.Fatalf("sent len = %d, want 1", got)
	}
	event, ok := server.sentAt(0).(contracts.SidecarStartedEvent)
	if !ok {
		t.Fatalf("sent type = %T, want SidecarStartedEvent", server.sentAt(0))
	}
	if event.Type != typeSidecarStartedEvent || event.WorkspaceID != "ws-1" || event.PID == 0 {
		t.Fatalf("event = %+v", event)
	}
	if event.StartedAt != bootTime.Format(time.RFC3339Nano) {
		t.Fatalf("startedAt = %q, want %q", event.StartedAt, bootTime.Format(time.RFC3339Nano))
	}
}

func TestSidecarStopCommandSendsStoppedEventThenCloses(t *testing.T) {
	server := &fakeServer{}
	exitCode := -1
	handler := NewLifecycleHandler("ws-1", time.Now(), func(code int) { exitCode = code })
	handler.SetServer(server)

	raw := mustJSON(t, contracts.SidecarStopCommand{Type: typeSidecarStopCommand, WorkspaceID: "ws-1"})
	if err := handler.OnMessage(context.Background(), raw); err != nil {
		t.Fatalf("OnMessage() error = %v", err)
	}

	event, ok := server.sentAt(0).(contracts.SidecarStoppedEvent)
	if !ok {
		t.Fatalf("sent type = %T, want SidecarStoppedEvent", server.sentAt(0))
	}
	if event.Type != typeSidecarStoppedEvent || event.Reason != contracts.SidecarStoppedReasonRequested {
		t.Fatalf("event = %+v", event)
	}
	if event.ExitCode == nil || *event.ExitCode != 0 {
		t.Fatalf("exitCode = %v, want pointer to 0", event.ExitCode)
	}
	code, reason := server.closeState()
	if code != wsx.StatusNormalClosure || reason != "requested" {
		t.Fatalf("close = %d %q, want 1000 requested", code, reason)
	}
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exitCode)
	}
}

func TestSignalShutdownSendsNullExitCodeAndGoingAwayClose(t *testing.T) {
	server := &fakeServer{}
	exitCode := -1
	handler := NewLifecycleHandler("ws-1", time.Now(), func(int) {})
	handler.SetServer(server)

	handleShutdown(server, handler, func(code int) { exitCode = code })

	event, ok := server.sentAt(0).(contracts.SidecarStoppedEvent)
	if !ok {
		t.Fatalf("sent type = %T, want SidecarStoppedEvent", server.sentAt(0))
	}
	if event.ExitCode != nil {
		t.Fatalf("exitCode = %v, want nil", event.ExitCode)
	}
	code, reason := server.closeState()
	if code != wsx.StatusGoingAway || reason != "going away" {
		t.Fatalf("close = %d %q, want 1001 going away", code, reason)
	}
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exitCode)
	}
}

func TestUnknownTypeClosesWithInternalError(t *testing.T) {
	server := &fakeServer{}
	handler := NewLifecycleHandler("ws-1", time.Now(), func(int) {})
	handler.SetServer(server)

	if err := handler.OnMessage(context.Background(), []byte(`{"type":"Other"}`)); err == nil {
		t.Fatal("OnMessage() error = nil, want error")
	}
	code, reason := server.closeState()
	if code != wsx.StatusInternalError || reason != "unknown message type" {
		t.Fatalf("close = %d %q, want 1011 unknown message type", code, reason)
	}
}

func TestWorkspaceIDMismatchReturnsError(t *testing.T) {
	server := &fakeServer{}
	handler := NewLifecycleHandler("expected", time.Now(), func(int) {})
	handler.SetServer(server)

	raw := mustJSON(t, contracts.SidecarStartCommand{Type: typeSidecarStartCommand, WorkspaceID: "actual"})
	if err := handler.OnMessage(context.Background(), raw); err == nil {
		t.Fatal("OnMessage() error = nil, want workspace mismatch error")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
