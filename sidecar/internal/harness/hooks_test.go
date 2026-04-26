package harness

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

type recordingHookSink struct {
	inputs chan HookEventInput
}

func newRecordingHookSink() *recordingHookSink {
	return &recordingHookSink{inputs: make(chan HookEventInput, 8)}
}

func (s *recordingHookSink) HandleHookEvent(_ context.Context, input HookEventInput) (contracts.TabBadgeEvent, error) {
	s.inputs <- input
	return contracts.TabBadgeEvent{}, nil
}

func TestHookListenerAcceptsClientRoundTrip(t *testing.T) {
	sink := newRecordingHookSink()
	listener, cancel, errCh := startHookListenerForTest(t, shortHookTempDir(t), "ws-1", "secret-token", sink)
	defer stopHookListenerForTest(t, listener, cancel, errCh)

	assertPathPerm(t, filepath.Dir(listener.SocketPath()), hookSocketDirMode)
	assertPathPerm(t, listener.TokenPath(), hookTokenFileMode)
	assertPathPerm(t, listener.SocketPath(), hookSocketFileMode)

	payload := json.RawMessage(`{"session_id":"session-1","adapterName":"claude-code","timestamp":"2026-04-26T01:02:03.000000004Z","tool_name":"Read","tool_input":{"file_path":"hello.py"}}`)
	if err := SendHookEvent(context.Background(), HookClientConfig{
		SocketPath:  listener.SocketPath(),
		WorkspaceID: "ws-1",
		Event:       "PreToolUse",
		Payload:     payload,
	}); err != nil {
		t.Fatalf("SendHookEvent() error = %v", err)
	}

	input := receiveHookInput(t, sink)
	if input.EventName != "PreToolUse" || input.SessionID != "session-1" || input.AdapterName != "claude-code" || input.ToolName != "Read" {
		t.Fatalf("input = %+v", input)
	}
	if input.InputSummary != "file_path: hello.py" {
		t.Fatalf("input summary = %q, want file_path summary", input.InputSummary)
	}
	wantTimestamp := time.Date(2026, 4, 26, 1, 2, 3, 4, time.UTC)
	if !input.Timestamp.Equal(wantTimestamp) {
		t.Fatalf("timestamp = %s, want %s", input.Timestamp, wantTimestamp)
	}
}

func TestHookListenerRejectsTokenMismatch(t *testing.T) {
	sink := newRecordingHookSink()
	listener, cancel, errCh := startHookListenerForTest(t, shortHookTempDir(t), "ws-1", "secret-token", sink)
	defer stopHookListenerForTest(t, listener, cancel, errCh)

	event := mustEncodeWireHookEvent(t, WireHookEvent{
		Type:        HookEventType,
		WorkspaceID: "ws-1",
		Event:       "Stop",
		Payload:     json.RawMessage(`{"session_id":"session-1"}`),
	})
	writeRawHookFrame(t, listener.SocketPath(), "wrong-token", event)
	assertNoHookInput(t, sink)
}

func TestHookListenerRejectsWorkspaceMismatch(t *testing.T) {
	sink := newRecordingHookSink()
	listener, cancel, errCh := startHookListenerForTest(t, shortHookTempDir(t), "expected-ws", "secret-token", sink)
	defer stopHookListenerForTest(t, listener, cancel, errCh)

	event := mustEncodeWireHookEvent(t, WireHookEvent{
		Type:        HookEventType,
		WorkspaceID: "actual-ws",
		Event:       "Stop",
		Payload:     json.RawMessage(`{"session_id":"session-1"}`),
	})
	writeRawHookFrame(t, listener.SocketPath(), listener.Token(), event)
	assertNoHookInput(t, sink)
}

func TestHookListenerRemovesStaleSocketAndCleansUpOnShutdown(t *testing.T) {
	dataDir := shortHookTempDir(t)
	workspaceID := contracts.WorkspaceID("ws-stale")
	socketPath := HookSocketPath(dataDir, workspaceID)
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(socketPath, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	sink := newRecordingHookSink()
	listener, err := NewHookListener(HookListenerConfig{
		DataDir:     dataDir,
		WorkspaceID: workspaceID,
		Sink:        sink,
		Token:       "secret-token",
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- listener.Serve(ctx) }()
	readyCtx, readyCancel := context.WithTimeout(context.Background(), time.Second)
	defer readyCancel()
	if err := listener.WaitReady(readyCtx); err != nil {
		cancel()
		t.Fatalf("WaitReady() error = %v", err)
	}

	info, err := os.Stat(socketPath)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		cancel()
		t.Fatalf("socket path mode = %s, want Unix socket", info.Mode())
	}

	cancel()
	if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Serve() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("listener did not shut down")
	}
	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket exists after shutdown err=%v", err)
	}
}

func TestHookEventInputFromWireMapsCommonPayloadFields(t *testing.T) {
	input, err := HookEventInputFromWire(WireHookEvent{
		Type:        HookEventType,
		WorkspaceID: "ws-1",
		Event:       "Notification",
		Payload: json.RawMessage(`{
			"sessionId":"session-1",
			"adapter_name":"claude-code",
			"notification_type":"permission_prompt",
			"timestamp":"2026-04-26T01:02:03Z",
			"errorMessage":"approval failed",
			"tool_name":"Bash",
			"tool_use_id":"toolu_001",
			"tool_input":{"command":"printf hello","description":"test command"},
			"tool_response":{"success":true},
			"message":"Claude needs permission"
		}`),
	})
	if err != nil {
		t.Fatalf("HookEventInputFromWire() error = %v", err)
	}
	if input.EventName != "Notification" || input.SessionID != "session-1" || input.AdapterName != "claude-code" {
		t.Fatalf("input = %+v", input)
	}
	if input.NotificationType != "permission_prompt" {
		t.Fatalf("notificationType = %q, want permission_prompt", input.NotificationType)
	}
	if input.ToolName != "Bash" || input.ToolCallID != "toolu_001" {
		t.Fatalf("tool fields = name:%q id:%q", input.ToolName, input.ToolCallID)
	}
	if input.InputSummary != "command: printf hello, description: test command" {
		t.Fatalf("input summary = %q", input.InputSummary)
	}
	if input.ResultSummary != "success: true" {
		t.Fatalf("result summary = %q", input.ResultSummary)
	}
	if input.Message != "Claude needs permission" {
		t.Fatalf("message = %q", input.Message)
	}
	if !input.HasError || input.ErrorMessage != "approval failed" {
		t.Fatalf("error fields = hasError:%v message:%q", input.HasError, input.ErrorMessage)
	}
}

func TestHookEventInputFromWireSummarizesLargeTextFields(t *testing.T) {
	input, err := HookEventInputFromWire(WireHookEvent{
		Type:        HookEventType,
		WorkspaceID: "ws-1",
		Event:       "PreToolUse",
		Payload: json.RawMessage(`{
			"session_id":"session-1",
			"tool_name":"Edit",
			"tool_input":{
				"file_path":"hello.py",
				"old_string":"abcdefghijklmnopqrstuvwxyz",
				"new_string":"0123456789"
			}
		}`),
	})
	if err != nil {
		t.Fatalf("HookEventInputFromWire() error = %v", err)
	}
	want := "file_path: hello.py, old_string: <26 chars>, new_string: <10 chars>"
	if input.InputSummary != want {
		t.Fatalf("input summary = %q, want %q", input.InputSummary, want)
	}
}

func startHookListenerForTest(t *testing.T, dataDir string, workspaceID contracts.WorkspaceID, token string, sink HookEventSink) (*HookListener, context.CancelFunc, <-chan error) {
	t.Helper()
	listener, err := NewHookListener(HookListenerConfig{
		DataDir:     dataDir,
		WorkspaceID: workspaceID,
		Sink:        sink,
		Token:       token,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- listener.Serve(ctx) }()
	readyCtx, readyCancel := context.WithTimeout(context.Background(), time.Second)
	defer readyCancel()
	if err := listener.WaitReady(readyCtx); err != nil {
		cancel()
		t.Fatalf("WaitReady() error = %v", err)
	}
	return listener, cancel, errCh
}

func stopHookListenerForTest(t *testing.T, listener *HookListener, cancel context.CancelFunc, errCh <-chan error) {
	t.Helper()
	cancel()
	if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Serve() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("listener did not shut down")
	}
}

func receiveHookInput(t *testing.T, sink *recordingHookSink) HookEventInput {
	t.Helper()
	select {
	case input := <-sink.inputs:
		return input
	case <-time.After(time.Second):
		t.Fatal("sink did not receive hook input")
	}
	return HookEventInput{}
}

func assertNoHookInput(t *testing.T, sink *recordingHookSink) {
	t.Helper()
	select {
	case input := <-sink.inputs:
		t.Fatalf("sink received unexpected input %+v", input)
	case <-time.After(100 * time.Millisecond):
	}
}

func assertPathPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s perm = %#o, want %#o", path, got, want)
	}
}

func mustEncodeWireHookEvent(t *testing.T, event WireHookEvent) []byte {
	t.Helper()
	encoded, err := EncodeWireHookEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func writeRawHookFrame(t *testing.T, socketPath, token string, encodedEvent []byte) {
	t.Helper()
	conn, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(token + "\n" + string(encodedEvent) + "\n")); err != nil {
		t.Fatal(err)
	}
}

func shortHookTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nx-hook-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
