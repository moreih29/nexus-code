package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
	"nexus-code/sidecar/internal/harness"
)

type commandHookSink struct {
	inputs chan harness.HookEventInput
}

func newCommandHookSink() *commandHookSink {
	return &commandHookSink{inputs: make(chan harness.HookEventInput, 4)}
}

func (s *commandHookSink) HandleHookEvent(_ context.Context, input harness.HookEventInput) (contracts.TabBadgeEvent, error) {
	s.inputs <- input
	return contracts.TabBadgeEvent{}, nil
}

func TestRunHookCommandSendsHookEventWithoutSidecarTokenEnv(t *testing.T) {
	t.Setenv("NEXUS_SIDECAR_TOKEN", "")
	sink := newCommandHookSink()
	listener, cancel, errCh := startCommandHookListener(t, sink)
	defer stopCommandHookListener(t, listener, cancel, errCh)

	stderr := &strings.Builder{}
	exitCode := runHookCommand(
		[]string{"--socket", listener.SocketPath(), "--workspace-id", "ws-main", "--adapter", "codex", "--event", "Stop"},
		strings.NewReader(`{"session_id":"session-main"}`),
		io.Discard,
		stderr,
	)
	if exitCode != 0 {
		t.Fatalf("runHookCommand() exit = %d stderr=%q", exitCode, stderr.String())
	}

	select {
	case input := <-sink.inputs:
		if input.EventName != "Stop" || input.SessionID != "session-main" || input.AdapterName != "codex" {
			t.Fatalf("input = %+v", input)
		}
	case <-time.After(time.Second):
		t.Fatal("sink did not receive hook event")
	}
}

func TestParseServerOptionsSupportsDataDirAndWorkspaceFlagForms(t *testing.T) {
	options := parseServerOptions([]string{"--data-dir", "/tmp/nexus-data", "--workspace-id=ws-1"})
	if options.workspaceID != "ws-1" || options.dataDir != "/tmp/nexus-data" {
		t.Fatalf("options = %+v", options)
	}

	options = parseServerOptions([]string{"--workspace-id", "ws-2", "--data-dir=/tmp/nexus-data-2"})
	if options.workspaceID != "ws-2" || options.dataDir != "/tmp/nexus-data-2" {
		t.Fatalf("options = %+v", options)
	}
}

func startCommandHookListener(t *testing.T, sink harness.HookEventSink) (*harness.HookListener, context.CancelFunc, <-chan error) {
	t.Helper()
	listener, err := harness.NewHookListener(harness.HookListenerConfig{
		DataDir:     shortCommandHookTempDir(t),
		WorkspaceID: "ws-main",
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
	return listener, cancel, errCh
}

func shortCommandHookTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nx-hook-cmd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func stopCommandHookListener(t *testing.T, listener *harness.HookListener, cancel context.CancelFunc, errCh <-chan error) {
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
