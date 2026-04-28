package git

import (
	"context"
	"errors"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

func TestSupervisorStatusEmitsStatusReply(t *testing.T) {
	client := &fakeGitClient{
		status: contracts.GitStatusSummary{Branch: stringPtr("main"), Files: []contracts.GitStatusEntry{}},
	}
	emitted := []any{}
	supervisor := NewSupervisor(SupervisorOptions{
		Client: client,
		Emit: func(_ context.Context, msg any) error {
			emitted = append(emitted, msg)
			return nil
		},
		Now: fixedGitTime,
	})

	err := supervisor.Status(context.Background(), contracts.GitStatusCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionStatus,
		RequestID:   "req-status",
		WorkspaceID: "ws-1",
		Cwd:         "/workspace",
	})
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}

	reply, ok := emitted[0].(contracts.GitStatusReply)
	if !ok {
		t.Fatalf("emitted type = %T, want GitStatusReply", emitted[0])
	}
	if reply.Action != contracts.GitLifecycleActionStatusResult || reply.RequestID != "req-status" || reply.GeneratedAt != fixedGitTime().Format(time.RFC3339Nano) {
		t.Fatalf("reply = %+v", reply)
	}
}

func TestSupervisorFailureEmitsGitFailedEvent(t *testing.T) {
	client := &fakeGitClient{stageErr: errors.New("stage failed")}
	emitted := []any{}
	supervisor := NewSupervisor(SupervisorOptions{
		Client: client,
		Emit: func(_ context.Context, msg any) error {
			emitted = append(emitted, msg)
			return nil
		},
		Now: fixedGitTime,
	})

	err := supervisor.Stage(context.Background(), contracts.GitStageCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionStage,
		RequestID:   "req-stage",
		WorkspaceID: "ws-1",
		Cwd:         "/workspace",
		Paths:       []string{"src/app.ts"},
	})
	if err != nil {
		t.Fatalf("Stage() error = %v", err)
	}

	event, ok := emitted[0].(contracts.GitFailedEvent)
	if !ok {
		t.Fatalf("emitted type = %T, want GitFailedEvent", emitted[0])
	}
	if event.Action != contracts.GitLifecycleActionFailed ||
		event.FailedAction != contracts.GitLifecycleActionStage ||
		event.RequestID != "req-stage" ||
		event.State != contracts.GitFailureStateError {
		t.Fatalf("event = %+v", event)
	}
}

func TestSupervisorWatchStartAndDebouncedCallbackEmitStatusChange(t *testing.T) {
	client := &fakeGitClient{
		status: contracts.GitStatusSummary{
			Branch: stringPtr("main"),
			Files: []contracts.GitStatusEntry{{
				Path:           "src/app.ts",
				OriginalPath:   nil,
				Status:         " M",
				IndexStatus:    " ",
				WorkTreeStatus: "M",
				Kind:           contracts.GitFileStatusKindModified,
			}},
		},
	}
	factory := &fakeWatcherFactory{}
	emitted := make(chan any, 4)
	supervisor := NewSupervisor(SupervisorOptions{
		Client: client,
		WatcherFactory: func(options WatcherOptions) (WatchHandle, error) {
			return factory.New(options)
		},
		Emit: func(_ context.Context, msg any) error {
			emitted <- msg
			return nil
		},
		Now: fixedGitTime,
	})

	debounceMs := 25
	err := supervisor.WatchStart(context.Background(), contracts.GitWatchStartCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionWatchStart,
		RequestID:   "req-watch",
		WorkspaceID: "ws-1",
		Cwd:         "/workspace",
		WatchID:     "watch-1",
		DebounceMs:  &debounceMs,
	})
	if err != nil {
		t.Fatalf("WatchStart() error = %v", err)
	}
	started := waitForGitMessage[contracts.GitWatchStartedReply](t, emitted)
	if started.WatchID != "watch-1" || started.WatchedPaths[0] != "/workspace" {
		t.Fatalf("started = %+v", started)
	}

	factory.options.OnChange()
	change := waitForGitMessage[contracts.GitStatusChangeEvent](t, emitted)
	if change.Type != MessageTypeRelay ||
		change.Kind != contracts.GitRelayKindStatusChange ||
		change.Seq != 1 ||
		len(change.Summary.Files) != 1 {
		t.Fatalf("change = %+v", change)
	}
}

func TestSupervisorHandleLifecycleRejectsWorkspaceMismatch(t *testing.T) {
	supervisor := NewSupervisor(SupervisorOptions{Client: &fakeGitClient{}})
	raw := []byte(`{"type":"git/lifecycle","action":"status","requestId":"req","workspaceId":"actual","cwd":"/workspace"}`)
	if err := supervisor.HandleLifecycle(context.Background(), raw, "expected"); err == nil {
		t.Fatal("HandleLifecycle() error = nil, want workspace mismatch")
	}
}

type fakeGitClient struct {
	status   contracts.GitStatusSummary
	branches []contracts.GitBranch
	stageErr error
}

func (c *fakeGitClient) Status(context.Context, string) (contracts.GitStatusSummary, error) {
	return c.status, nil
}

func (c *fakeGitClient) BranchList(context.Context, string) ([]contracts.GitBranch, error) {
	return c.branches, nil
}

func (c *fakeGitClient) Commit(context.Context, string, string, bool) (string, error) {
	return "abc123", nil
}

func (c *fakeGitClient) Stage(context.Context, string, []string) error   { return c.stageErr }
func (c *fakeGitClient) Unstage(context.Context, string, []string) error { return nil }
func (c *fakeGitClient) Discard(context.Context, string, []string) error { return nil }
func (c *fakeGitClient) Checkout(context.Context, string, string) error  { return nil }
func (c *fakeGitClient) BranchCreate(context.Context, string, string, *string) error {
	return nil
}
func (c *fakeGitClient) BranchDelete(context.Context, string, string, bool) error {
	return nil
}
func (c *fakeGitClient) Diff(context.Context, string, bool, []string) (string, error) {
	return "diff", nil
}

type fakeWatcherFactory struct {
	options WatcherOptions
}

func (f *fakeWatcherFactory) New(options WatcherOptions) (WatchHandle, error) {
	f.options = options
	return fakeWatchHandle{paths: []string{options.Cwd}}, nil
}

type fakeWatchHandle struct {
	paths []string
}

func (h fakeWatchHandle) Close() error           { return nil }
func (h fakeWatchHandle) WatchedPaths() []string { return append([]string(nil), h.paths...) }

func fixedGitTime() time.Time {
	return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC)
}

func stringPtr(value string) *string { return &value }

func waitForGitMessage[T any](t *testing.T, emitted <-chan any) T {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case message := <-emitted:
			if typed, ok := message.(T); ok {
				return typed
			}
		case <-timer.C:
			var zero T
			t.Fatalf("timed out waiting for %T", zero)
		}
	}
}
