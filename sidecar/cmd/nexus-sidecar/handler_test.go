package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
	"nexus-code/sidecar/internal/harness"
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

func TestLifecycleHandlerHarnessObserverUsesConfiguredServer(t *testing.T) {
	server := &fakeServer{}
	handler := NewLifecycleHandler("ws-1", time.Now(), func(int) {})
	handler.SetServer(server)

	_, err := handler.HarnessObserver().HandleHookEvent(context.Background(), harness.HookEventInput{
		EventName:   "PreToolUse",
		SessionID:   "s-1",
		AdapterName: "claude-code",
		ToolName:    "Read",
	})
	if err != nil {
		t.Fatalf("HandleHookEvent() error = %v", err)
	}

	if got := server.sentLen(); got != 2 {
		t.Fatalf("sent len = %d, want 2", got)
	}
	event, ok := server.sentAt(0).(contracts.TabBadgeEvent)
	if !ok {
		t.Fatalf("sent type = %T, want TabBadgeEvent", server.sentAt(0))
	}
	if event.Type != harness.TabBadgeEventType ||
		event.State != contracts.TabBadgeStateRunning ||
		event.SessionID != "s-1" ||
		event.AdapterName != "claude-code" ||
		event.WorkspaceID != "ws-1" {
		t.Fatalf("event = %+v", event)
	}
	toolCall, ok := server.sentAt(1).(contracts.ToolCallEvent)
	if !ok {
		t.Fatalf("sent type = %T, want ToolCallEvent", server.sentAt(1))
	}
	if toolCall.Type != harness.ToolCallEventType ||
		toolCall.Status != contracts.ToolCallStatusStarted ||
		toolCall.ToolName != "Read" ||
		toolCall.SessionID != "s-1" ||
		toolCall.WorkspaceID != "ws-1" {
		t.Fatalf("tool call = %+v", toolCall)
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

func TestSearchLifecycleCancelRoutesToSearchSupervisor(t *testing.T) {
	server := &fakeServer{}
	handler := NewLifecycleHandler("ws-1", time.Now(), func(int) {})
	handler.SetServer(server)

	raw := mustJSON(t, contracts.SearchCancelCommand{
		Type:        typeSearchLifecycleMessage,
		Action:      contracts.SearchLifecycleActionCancel,
		RequestID:   "req-cancel",
		WorkspaceID: "ws-1",
		SessionID:   "search-1",
	})
	if err := handler.OnMessage(context.Background(), raw); err != nil {
		t.Fatalf("OnMessage() error = %v", err)
	}

	event, ok := server.sentAt(0).(contracts.SearchCanceledEvent)
	if !ok {
		t.Fatalf("sent type = %T, want SearchCanceledEvent", server.sentAt(0))
	}
	if event.Type != typeSearchLifecycleMessage ||
		event.Action != contracts.SearchLifecycleActionCanceled ||
		event.RequestID != "req-cancel" ||
		event.WorkspaceID != "ws-1" ||
		event.SessionID != "search-1" {
		t.Fatalf("event = %+v", event)
	}
}

func TestGitLifecycleSmokeStatusBranchListAndStatusChange(t *testing.T) {
	requireGit(t)
	workspaceRoot := t.TempDir()
	runGit(t, workspaceRoot, "init")
	runGit(t, workspaceRoot, "config", "user.email", "nexus@example.invalid")
	runGit(t, workspaceRoot, "config", "user.name", "Nexus Test")
	if err := os.WriteFile(filepath.Join(workspaceRoot, "README.md"), []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, workspaceRoot, "add", "README.md")
	runGit(t, workspaceRoot, "commit", "-m", "init")

	server := &fakeServer{}
	handler := NewLifecycleHandler("ws-1", time.Now(), func(int) {})
	handler.SetServer(server)

	if err := handler.OnMessage(context.Background(), mustJSON(t, contracts.GitStatusCommand{
		Type:        typeGitLifecycleMessage,
		Action:      contracts.GitLifecycleActionStatus,
		RequestID:   "req-status",
		WorkspaceID: "ws-1",
		Cwd:         workspaceRoot,
	})); err != nil {
		t.Fatalf("git status OnMessage() error = %v", err)
	}
	status := waitForSent[contracts.GitStatusReply](t, server, time.Second)
	if status.Action != contracts.GitLifecycleActionStatusResult {
		t.Fatalf("status = %+v", status)
	}

	if err := handler.OnMessage(context.Background(), mustJSON(t, contracts.GitBranchListCommand{
		Type:        typeGitLifecycleMessage,
		Action:      contracts.GitLifecycleActionBranchList,
		RequestID:   "req-branches",
		WorkspaceID: "ws-1",
		Cwd:         workspaceRoot,
	})); err != nil {
		t.Fatalf("git branch_list OnMessage() error = %v", err)
	}
	branches := waitForSent[contracts.GitBranchListReply](t, server, time.Second)
	if len(branches.Branches) == 0 {
		t.Fatalf("branches = %+v, want at least one branch", branches)
	}

	debounceMs := 50
	if err := handler.OnMessage(context.Background(), mustJSON(t, contracts.GitWatchStartCommand{
		Type:        typeGitLifecycleMessage,
		Action:      contracts.GitLifecycleActionWatchStart,
		RequestID:   "req-watch",
		WorkspaceID: "ws-1",
		Cwd:         workspaceRoot,
		WatchID:     "watch-1",
		DebounceMs:  &debounceMs,
	})); err != nil {
		t.Fatalf("git watch_start OnMessage() error = %v", err)
	}
	_ = waitForSent[contracts.GitWatchStartedReply](t, server, time.Second)

	if err := os.WriteFile(filepath.Join(workspaceRoot, "changed.txt"), []byte("change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	change := waitForSent[contracts.GitStatusChangeEvent](t, server, 5*time.Second)
	if change.Kind != contracts.GitRelayKindStatusChange || len(change.Summary.Files) == 0 {
		t.Fatalf("change = %+v", change)
	}
	handler.OnClose(0, "")
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not available on PATH: %v", err)
	}
}

func runGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func waitForSent[T any](t *testing.T, server *fakeServer, timeout time.Duration) T {
	t.Helper()
	deadline := time.Now().Add(timeout)
	seen := 0
	for time.Now().Before(deadline) {
		for seen < server.sentLen() {
			message := server.sentAt(seen)
			seen++
			if typed, ok := message.(T); ok {
				return typed
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	var zero T
	t.Fatalf("timed out waiting for sent %T", zero)
	return zero
}
