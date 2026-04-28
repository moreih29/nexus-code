package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

const (
	MessageTypeLifecycle = "git/lifecycle"
	MessageTypeRelay     = "git/relay"

	defaultDebounce    = 150 * time.Millisecond
	defaultEmitTimeout = 2 * time.Second
)

type EmitFunc func(context.Context, any) error

type SupervisorOptions struct {
	Client          Client
	WatcherFactory  WatcherFactory
	Now             func() time.Time
	Emit            EmitFunc
	DefaultDebounce time.Duration
}

type Supervisor struct {
	mu              sync.Mutex
	client          Client
	watcherFactory  WatcherFactory
	now             func() time.Time
	emit            EmitFunc
	defaultDebounce time.Duration
	watches         map[string]*watchRecord
	relaySeq        atomic.Int64
}

type watchRecord struct {
	workspaceID contracts.WorkspaceID
	watchID     string
	cwd         string
	handle      WatchHandle
}

func NewSupervisor(options SupervisorOptions) *Supervisor {
	client := options.Client
	if client == nil {
		client = NewCLI()
	}
	watcherFactory := options.WatcherFactory
	if watcherFactory == nil {
		watcherFactory = NewFSNotifyWatcher
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	emit := options.Emit
	if emit == nil {
		emit = func(context.Context, any) error { return nil }
	}
	debounce := options.DefaultDebounce
	if debounce <= 0 {
		debounce = defaultDebounce
	}

	return &Supervisor{
		client:          client,
		watcherFactory:  watcherFactory,
		now:             now,
		emit:            emit,
		defaultDebounce: debounce,
		watches:         map[string]*watchRecord{},
	}
}

func (s *Supervisor) HandleLifecycle(ctx context.Context, raw []byte, expectedWorkspaceID string) error {
	var envelope struct {
		Action      contracts.GitLifecycleAction `json:"action"`
		WorkspaceID contracts.WorkspaceID        `json:"workspaceId"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshal git lifecycle envelope: %w", err)
	}
	if string(envelope.WorkspaceID) != expectedWorkspaceID {
		return fmt.Errorf("workspaceId mismatch: got %q", envelope.WorkspaceID)
	}

	switch envelope.Action {
	case contracts.GitLifecycleActionStatus:
		var cmd contracts.GitStatusCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitStatusCommand: %w", err)
		}
		return s.Status(ctx, cmd)
	case contracts.GitLifecycleActionBranchList:
		var cmd contracts.GitBranchListCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitBranchListCommand: %w", err)
		}
		return s.BranchList(ctx, cmd)
	case contracts.GitLifecycleActionCommit:
		var cmd contracts.GitCommitCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitCommitCommand: %w", err)
		}
		return s.Commit(ctx, cmd)
	case contracts.GitLifecycleActionStage:
		var cmd contracts.GitStageCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitStageCommand: %w", err)
		}
		return s.Stage(ctx, cmd)
	case contracts.GitLifecycleActionUnstage:
		var cmd contracts.GitUnstageCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitUnstageCommand: %w", err)
		}
		return s.Unstage(ctx, cmd)
	case contracts.GitLifecycleActionDiscard:
		var cmd contracts.GitDiscardCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitDiscardCommand: %w", err)
		}
		return s.Discard(ctx, cmd)
	case contracts.GitLifecycleActionCheckout:
		var cmd contracts.GitCheckoutCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitCheckoutCommand: %w", err)
		}
		return s.Checkout(ctx, cmd)
	case contracts.GitLifecycleActionBranchCreate:
		var cmd contracts.GitBranchCreateCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitBranchCreateCommand: %w", err)
		}
		return s.BranchCreate(ctx, cmd)
	case contracts.GitLifecycleActionBranchDelete:
		var cmd contracts.GitBranchDeleteCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitBranchDeleteCommand: %w", err)
		}
		return s.BranchDelete(ctx, cmd)
	case contracts.GitLifecycleActionDiff:
		var cmd contracts.GitDiffCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitDiffCommand: %w", err)
		}
		return s.Diff(ctx, cmd)
	case contracts.GitLifecycleActionWatchStart:
		var cmd contracts.GitWatchStartCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitWatchStartCommand: %w", err)
		}
		return s.WatchStart(ctx, cmd)
	case contracts.GitLifecycleActionWatchStop:
		var cmd contracts.GitWatchStopCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal GitWatchStopCommand: %w", err)
		}
		return s.WatchStop(ctx, cmd)
	default:
		return fmt.Errorf("unknown git lifecycle action %q", envelope.Action)
	}
}

func (s *Supervisor) Status(ctx context.Context, cmd contracts.GitStatusCommand) error {
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitStatusReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionStatusResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Summary:     summary,
		GeneratedAt: s.timestamp(),
	})
}

func (s *Supervisor) BranchList(ctx context.Context, cmd contracts.GitBranchListCommand) error {
	branches, err := s.client.BranchList(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitBranchListReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionBranchListResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Branches:    branches,
		GeneratedAt: s.timestamp(),
	})
}

func (s *Supervisor) Commit(ctx context.Context, cmd contracts.GitCommitCommand) error {
	oid, err := s.client.Commit(ctx, cmd.Cwd, cmd.Message, cmd.Amend)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitCommitReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionCommitResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		CommitOid:   oid,
		Summary:     summary,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) Stage(ctx context.Context, cmd contracts.GitStageCommand) error {
	if err := s.client.Stage(ctx, cmd.Cwd, cmd.Paths); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitStageReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionStageResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Summary:     summary,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) Unstage(ctx context.Context, cmd contracts.GitUnstageCommand) error {
	if err := s.client.Unstage(ctx, cmd.Cwd, cmd.Paths); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitUnstageReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionUnstageResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Summary:     summary,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) Discard(ctx context.Context, cmd contracts.GitDiscardCommand) error {
	if err := s.client.Discard(ctx, cmd.Cwd, cmd.Paths); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitDiscardReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionDiscardResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Summary:     summary,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) Checkout(ctx context.Context, cmd contracts.GitCheckoutCommand) error {
	if err := s.client.Checkout(ctx, cmd.Cwd, cmd.Ref); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	summary, err := s.client.Status(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitCheckoutReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionCheckoutResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Summary:     summary,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) BranchCreate(ctx context.Context, cmd contracts.GitBranchCreateCommand) error {
	if err := s.client.BranchCreate(ctx, cmd.Cwd, cmd.Name, cmd.StartPoint); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	branches, err := s.client.BranchList(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitBranchCreateReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionBranchCreateResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Branches:    branches,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) BranchDelete(ctx context.Context, cmd contracts.GitBranchDeleteCommand) error {
	if err := s.client.BranchDelete(ctx, cmd.Cwd, cmd.Name, cmd.Force); err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	branches, err := s.client.BranchList(ctx, cmd.Cwd)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitBranchDeleteReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionBranchDeleteResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Branches:    branches,
		CompletedAt: s.timestamp(),
	})
}

func (s *Supervisor) Diff(ctx context.Context, cmd contracts.GitDiffCommand) error {
	diff, err := s.client.Diff(ctx, cmd.Cwd, cmd.Staged, cmd.Paths)
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	return s.emit(ctx, contracts.GitDiffReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionDiffResult,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		Cwd:         cmd.Cwd,
		Staged:      cmd.Staged,
		Paths:       append([]string(nil), cmd.Paths...),
		Diff:        diff,
		GeneratedAt: s.timestamp(),
	})
}

func (s *Supervisor) WatchStart(ctx context.Context, cmd contracts.GitWatchStartCommand) error {
	debounce := s.defaultDebounce
	if cmd.DebounceMs != nil && *cmd.DebounceMs > 0 {
		debounce = time.Duration(*cmd.DebounceMs) * time.Millisecond
	}

	record := &watchRecord{
		workspaceID: cmd.WorkspaceID,
		watchID:     cmd.WatchID,
		cwd:         cmd.Cwd,
	}
	handle, err := s.watcherFactory(WatcherOptions{
		WorkspaceID: cmd.WorkspaceID,
		WatchID:     cmd.WatchID,
		Cwd:         cmd.Cwd,
		Debounce:    debounce,
		OnChange: func() {
			s.emitStatusChange(record)
		},
	})
	if err != nil {
		return s.emitFailure(ctx, cmd.Action, cmd.RequestID, cmd.WorkspaceID, cmd.Cwd, err)
	}
	record.handle = handle

	s.mu.Lock()
	if existing := s.watches[cmd.WatchID]; existing != nil {
		_ = existing.handle.Close()
	}
	s.watches[cmd.WatchID] = record
	s.mu.Unlock()

	return s.emit(ctx, contracts.GitWatchStartedReply{
		Type:         MessageTypeLifecycle,
		Action:       contracts.GitLifecycleActionWatchStarted,
		RequestID:    cmd.RequestID,
		WorkspaceID:  cmd.WorkspaceID,
		Cwd:          cmd.Cwd,
		WatchID:      cmd.WatchID,
		WatchedPaths: handle.WatchedPaths(),
		StartedAt:    s.timestamp(),
	})
}

func (s *Supervisor) WatchStop(ctx context.Context, cmd contracts.GitWatchStopCommand) error {
	s.mu.Lock()
	record := s.watches[cmd.WatchID]
	if record != nil {
		delete(s.watches, cmd.WatchID)
	}
	s.mu.Unlock()

	if record != nil {
		_ = record.handle.Close()
	}
	return s.emit(ctx, contracts.GitWatchStoppedReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.GitLifecycleActionWatchStopped,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		WatchID:     cmd.WatchID,
		StoppedAt:   s.timestamp(),
	})
}

func (s *Supervisor) ShutdownAll(_ context.Context, workspaceID *contracts.WorkspaceID) error {
	s.mu.Lock()
	records := []*watchRecord{}
	for watchID, record := range s.watches {
		if workspaceID != nil && record.workspaceID != *workspaceID {
			continue
		}
		records = append(records, record)
		delete(s.watches, watchID)
	}
	s.mu.Unlock()

	for _, record := range records {
		_ = record.handle.Close()
	}
	return nil
}

func (s *Supervisor) emitStatusChange(record *watchRecord) {
	if record == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultEmitTimeout)
	defer cancel()

	summary, err := s.client.Status(ctx, record.cwd)
	if err != nil {
		_ = s.emitFailure(ctx, contracts.GitLifecycleActionStatus, "watch-"+record.watchID, record.workspaceID, record.cwd, err)
		return
	}
	_ = s.emit(ctx, contracts.GitStatusChangeEvent{
		Type:        MessageTypeRelay,
		Kind:        contracts.GitRelayKindStatusChange,
		WorkspaceID: record.workspaceID,
		WatchID:     record.watchID,
		Cwd:         record.cwd,
		Seq:         int(s.relaySeq.Add(1)),
		Summary:     summary,
		ChangedAt:   s.timestamp(),
	})
}

func (s *Supervisor) emitFailure(
	ctx context.Context,
	failedAction contracts.GitLifecycleAction,
	requestID string,
	workspaceID contracts.WorkspaceID,
	cwd string,
	err error,
) error {
	state, message, exitCode, stderr := classifyGitError(err)
	return s.emit(ctx, contracts.GitFailedEvent{
		Type:         MessageTypeLifecycle,
		Action:       contracts.GitLifecycleActionFailed,
		FailedAction: failedAction,
		RequestID:    requestID,
		WorkspaceID:  workspaceID,
		Cwd:          cwd,
		State:        state,
		Message:      message,
		ExitCode:     exitCode,
		Stderr:       stderr,
		FailedAt:     s.timestamp(),
	})
}

func (s *Supervisor) timestamp() string {
	return s.now().UTC().Format(time.RFC3339Nano)
}

func classifyGitError(err error) (contracts.GitFailureState, string, *int, string) {
	state := contracts.GitFailureStateError
	message := err.Error()
	var exitCode *int
	stderr := ""

	var commandErr *CommandError
	if errors.As(err, &commandErr) {
		exitCode = commandErr.ExitCode
		stderr = commandErr.Stderr
		if stringsTrimmed := strings.TrimSpace(commandErr.Stderr); stringsTrimmed != "" {
			message = stringsTrimmed
		}
		if errors.Is(commandErr.Err, exec.ErrNotFound) || os.IsNotExist(commandErr.Err) {
			state = contracts.GitFailureStateUnavailable
			message = "git is not available on PATH."
		}
	}
	return state, message, exitCode, stderr
}
