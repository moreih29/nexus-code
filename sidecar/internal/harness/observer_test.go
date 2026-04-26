package harness

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

type fakeServer struct {
	mu    sync.Mutex
	sends []any
}

func (s *fakeServer) Serve(context.Context) error { return nil }

func (s *fakeServer) Send(_ context.Context, msg any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sends = append(s.sends, msg)
	return nil
}

func (s *fakeServer) Close(int, string) error { return nil }

func (s *fakeServer) sentLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sends)
}

func (s *fakeServer) sentAt(i int) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sends[i]
}

func TestNormalizeHookEventClaudeLikeAssumptionsMapToTabBadgeStates(t *testing.T) {
	fixedNow := time.Date(2026, 4, 26, 1, 2, 3, 4, time.FixedZone("KST", 9*60*60))
	observer := NewObserver("ws-1", WithClock(func() time.Time { return fixedNow }))

	for _, tc := range []struct {
		name  string
		input HookEventInput
		want  contracts.TabBadgeState
	}{
		{
			name:  "PreToolUse maps to running",
			input: HookEventInput{EventName: "PreToolUse", SessionID: "s-1", AdapterName: "claude-code"},
			want:  contracts.TabBadgeStateRunning,
		},
		{
			name:  "permission prompt Notification maps to awaiting approval",
			input: HookEventInput{EventName: "Notification", NotificationType: "permission_prompt", SessionID: "s-1", AdapterName: "claude-code"},
			want:  contracts.TabBadgeStateAwaitingApproval,
		},
		{
			name:  "Stop maps to completed",
			input: HookEventInput{EventName: "Stop", SessionID: "s-1", AdapterName: "claude-code"},
			want:  contracts.TabBadgeStateCompleted,
		},
		{
			name:  "error-like name maps to error",
			input: HookEventInput{EventName: "ToolError", SessionID: "s-1", AdapterName: "claude-code"},
			want:  contracts.TabBadgeStateError,
		},
		{
			name:  "error flag takes precedence over hook name",
			input: HookEventInput{EventName: "PreToolUse", SessionID: "s-1", AdapterName: "claude-code", HasError: true},
			want:  contracts.TabBadgeStateError,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event, err := observer.NormalizeHookEvent(tc.input)
			if err != nil {
				t.Fatalf("NormalizeHookEvent() error = %v", err)
			}
			if event.Type != TabBadgeEventType {
				t.Fatalf("type = %q, want %q", event.Type, TabBadgeEventType)
			}
			if event.State != tc.want {
				t.Fatalf("state = %q, want %q", event.State, tc.want)
			}
			if event.SessionID != "s-1" || event.AdapterName != "claude-code" || event.WorkspaceID != "ws-1" {
				t.Fatalf("event identity fields = %+v", event)
			}
			if event.Timestamp != fixedNow.UTC().Format(time.RFC3339Nano) {
				t.Fatalf("timestamp = %q, want %q", event.Timestamp, fixedNow.UTC().Format(time.RFC3339Nano))
			}
		})
	}
}

func TestNormalizeHookEventUsesExplicitTimestampAndDefaultAdapterName(t *testing.T) {
	explicitTimestamp := time.Date(2026, 4, 25, 10, 11, 12, 13, time.UTC)
	observer := NewObserver("ws-1", WithDefaultAdapterName("claude-code"))

	event, err := observer.NormalizeHookEvent(HookEventInput{
		EventName: "pre_tool_use",
		SessionID: " s-2 ",
		Timestamp: explicitTimestamp,
	})
	if err != nil {
		t.Fatalf("NormalizeHookEvent() error = %v", err)
	}
	if event.SessionID != "s-2" {
		t.Fatalf("sessionId = %q, want trimmed s-2", event.SessionID)
	}
	if event.AdapterName != "claude-code" {
		t.Fatalf("adapterName = %q, want default claude-code", event.AdapterName)
	}
	if event.Timestamp != explicitTimestamp.Format(time.RFC3339Nano) {
		t.Fatalf("timestamp = %q, want %q", event.Timestamp, explicitTimestamp.Format(time.RFC3339Nano))
	}
}

func TestNormalizeHookEventRejectsUnknownHookNamesUntilPayloadSchemaIsPinned(t *testing.T) {
	observer := NewObserver("ws-1", WithDefaultAdapterName("claude-code"))

	_, err := observer.NormalizeHookEvent(HookEventInput{EventName: "PostToolUse", SessionID: "s-1"})
	if !errors.Is(err, ErrUnsupportedHookEvent) {
		t.Fatalf("NormalizeHookEvent() error = %v, want ErrUnsupportedHookEvent", err)
	}
}

func TestNormalizeHookEventRejectsNonPermissionPromptNotification(t *testing.T) {
	observer := NewObserver("ws-1", WithDefaultAdapterName("claude-code"))

	_, err := observer.NormalizeHookEvent(HookEventInput{
		EventName:        "Notification",
		NotificationType: "idle",
		SessionID:        "s-1",
	})
	if !errors.Is(err, ErrUnsupportedHookEvent) {
		t.Fatalf("NormalizeHookEvent() error = %v, want ErrUnsupportedHookEvent", err)
	}
}

func TestNormalizeToolCallEventMapsClaudeHookPayloads(t *testing.T) {
	fixedNow := time.Date(2026, 4, 26, 1, 2, 3, 4, time.FixedZone("KST", 9*60*60))
	observer := NewObserver("ws-1", WithDefaultAdapterName("claude-code"), WithClock(func() time.Time { return fixedNow }))

	for _, tc := range []struct {
		name  string
		input HookEventInput
		want  contracts.ToolCallStatus
		tool  string
	}{
		{
			name:  "PreToolUse maps to started",
			input: HookEventInput{EventName: "PreToolUse", SessionID: "s-1", ToolName: "Read", InputSummary: "file_path: hello.py"},
			want:  contracts.ToolCallStatusStarted,
			tool:  "Read",
		},
		{
			name:  "PostToolUse maps to completed",
			input: HookEventInput{EventName: "PostToolUse", SessionID: "s-1", ToolName: "Edit", ResultSummary: "success: true"},
			want:  contracts.ToolCallStatusCompleted,
			tool:  "Edit",
		},
		{
			name:  "permission prompt Notification maps to awaiting approval fallback tool",
			input: HookEventInput{EventName: "Notification", NotificationType: "permission_prompt", SessionID: "s-1", Message: "Claude needs your permission"},
			want:  contracts.ToolCallStatusAwaitingApproval,
			tool:  "Permission",
		},
		{
			name:  "error payload maps to error",
			input: HookEventInput{EventName: "PreToolUse", SessionID: "s-1", ToolName: "Bash", HasError: true},
			want:  contracts.ToolCallStatusError,
			tool:  "Bash",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event, err := observer.NormalizeToolCallEvent(tc.input)
			if err != nil {
				t.Fatalf("NormalizeToolCallEvent() error = %v", err)
			}
			if event.Type != ToolCallEventType {
				t.Fatalf("type = %q, want %q", event.Type, ToolCallEventType)
			}
			if event.Status != tc.want {
				t.Fatalf("status = %q, want %q", event.Status, tc.want)
			}
			if event.ToolName != tc.tool {
				t.Fatalf("toolName = %q, want %q", event.ToolName, tc.tool)
			}
			if event.SessionID != "s-1" || event.AdapterName != "claude-code" || event.WorkspaceID != "ws-1" {
				t.Fatalf("event identity fields = %+v", event)
			}
			if event.Timestamp != fixedNow.UTC().Format(time.RFC3339Nano) {
				t.Fatalf("timestamp = %q, want %q", event.Timestamp, fixedNow.UTC().Format(time.RFC3339Nano))
			}
		})
	}
}

func TestHandleHookEventSendsTabBadgeEventThroughFakeWSXServer(t *testing.T) {
	server := &fakeServer{}
	fixedNow := time.Date(2026, 4, 26, 3, 4, 5, 6, time.UTC)
	observer := NewObserver(
		"ws-1",
		WithServer(server),
		WithClock(func() time.Time { return fixedNow }),
	)

	event, err := observer.HandleHookEvent(context.Background(), HookEventInput{
		EventName:        "Notification",
		NotificationType: "permission_prompt",
		SessionID:        "s-approval",
		AdapterName:      "claude-code",
		Message:          "Claude needs your permission to use Bash",
	})
	if err != nil {
		t.Fatalf("HandleHookEvent() error = %v", err)
	}
	if got := server.sentLen(); got != 2 {
		t.Fatalf("sent len = %d, want 2", got)
	}
	sent, ok := server.sentAt(0).(contracts.TabBadgeEvent)
	if !ok {
		t.Fatalf("sent type = %T, want contracts.TabBadgeEvent", server.sentAt(0))
	}
	if sent != event {
		t.Fatalf("sent event = %+v, want %+v", sent, event)
	}
	if sent.State != contracts.TabBadgeStateAwaitingApproval {
		t.Fatalf("state = %q, want awaiting-approval", sent.State)
	}
	toolCall, ok := server.sentAt(1).(contracts.ToolCallEvent)
	if !ok {
		t.Fatalf("sent type = %T, want contracts.ToolCallEvent", server.sentAt(1))
	}
	if toolCall.Status != contracts.ToolCallStatusAwaitingApproval || toolCall.ToolName != "Permission" {
		t.Fatalf("tool call = %+v, want awaiting Permission", toolCall)
	}
	if toolCall.Message != "Claude needs your permission to use Bash" {
		t.Fatalf("message = %q, want permission message", toolCall.Message)
	}
}

func TestHandleHookEventSendsPostToolUseToolCallWithoutBadge(t *testing.T) {
	server := &fakeServer{}
	fixedNow := time.Date(2026, 4, 26, 3, 4, 5, 6, time.UTC)
	observer := NewObserver(
		"ws-1",
		WithServer(server),
		WithDefaultAdapterName("claude-code"),
		WithClock(func() time.Time { return fixedNow }),
	)

	_, err := observer.HandleHookEvent(context.Background(), HookEventInput{
		EventName:     "PostToolUse",
		SessionID:     "s-post",
		ToolName:      "Edit",
		ResultSummary: "success: true",
		InputSummary:  "file_path: hello.py",
		ToolCallID:    "toolu_001",
		AdapterName:   "claude-code",
	})
	if err != nil {
		t.Fatalf("HandleHookEvent() error = %v", err)
	}
	if got := server.sentLen(); got != 1 {
		t.Fatalf("sent len = %d, want 1", got)
	}
	toolCall, ok := server.sentAt(0).(contracts.ToolCallEvent)
	if !ok {
		t.Fatalf("sent type = %T, want contracts.ToolCallEvent", server.sentAt(0))
	}
	if toolCall.Status != contracts.ToolCallStatusCompleted || toolCall.ToolName != "Edit" {
		t.Fatalf("tool call = %+v, want completed Edit", toolCall)
	}
	if toolCall.ToolCallID != "toolu_001" || toolCall.InputSummary != "file_path: hello.py" || toolCall.ResultSummary != "success: true" {
		t.Fatalf("tool call summaries = %+v", toolCall)
	}
}

func TestHandleHookEventIgnoresUnsupportedNotification(t *testing.T) {
	server := &fakeServer{}
	observer := NewObserver("ws-1", WithServer(server), WithDefaultAdapterName("claude-code"))

	_, err := observer.HandleHookEvent(context.Background(), HookEventInput{
		EventName:        "Notification",
		NotificationType: "idle",
		SessionID:        "s-idle",
	})
	if err != nil {
		t.Fatalf("HandleHookEvent() error = %v, want ignored unsupported notification", err)
	}
	if got := server.sentLen(); got != 0 {
		t.Fatalf("sent len = %d, want 0", got)
	}
}

func TestHandleHookEventRequiresConfiguredServer(t *testing.T) {
	observer := NewObserver("ws-1", WithDefaultAdapterName("claude-code"))

	_, err := observer.HandleHookEvent(context.Background(), HookEventInput{EventName: "Stop", SessionID: "s-1"})
	if !errors.Is(err, ErrServerNotConfigured) {
		t.Fatalf("HandleHookEvent() error = %v, want ErrServerNotConfigured", err)
	}
}
