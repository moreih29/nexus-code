package search

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

const (
	MessageTypeLifecycle = "search/lifecycle"
	MessageTypeRelay     = "search/relay"

	DefaultResultLimit = 10000

	defaultChunkSize        = 100
	defaultTerminateTimeout = 5 * time.Second
	defaultEmitTimeout      = 2 * time.Second
	maxRipgrepJSONLineBytes = 10 * 1024 * 1024
	maxStderrBytes          = 8 * 1024
)

type EmitFunc func(context.Context, any) error

type SupervisorOptions struct {
	ProcessFactory   ProcessFactory
	RipgrepResolver  RipgrepResolver
	TerminateTimeout time.Duration
	Now              func() time.Time
	Emit             EmitFunc
	ChunkSize        int
	ResultLimit      int
}

type Supervisor struct {
	mu               sync.Mutex
	sessions         map[string]*sessionRecord
	processFactory   ProcessFactory
	ripgrepResolver  RipgrepResolver
	terminateTimeout time.Duration
	now              func() time.Time
	emit             EmitFunc
	chunkSize        int
	resultLimit      int
	relaySeq         atomic.Int64
}

type sessionRecord struct {
	spec           ProcessSpec
	requestID      string
	process        ManagedProcess
	stderrDone     chan struct{}
	finished       chan struct{}
	stderr         *limitedBuffer
	startedAt      string
	cancelRequest  string
	cancelMessage  string
	matchCount     int
	files          map[string]struct{}
	truncated      bool
	terminationSet bool

	mu        sync.Mutex
	canceling bool
}

func NewSupervisor(options SupervisorOptions) *Supervisor {
	processFactory := options.ProcessFactory
	if processFactory == nil {
		processFactory = NewExecProcess
	}
	ripgrepResolver := options.RipgrepResolver
	if ripgrepResolver == nil {
		ripgrepResolver = ResolveRipgrepPath
	}
	terminateTimeout := options.TerminateTimeout
	if terminateTimeout <= 0 {
		terminateTimeout = defaultTerminateTimeout
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	emit := options.Emit
	if emit == nil {
		emit = func(context.Context, any) error { return nil }
	}
	chunkSize := options.ChunkSize
	if chunkSize <= 0 {
		chunkSize = defaultChunkSize
	}
	resultLimit := options.ResultLimit
	if resultLimit <= 0 || resultLimit > DefaultResultLimit {
		resultLimit = DefaultResultLimit
	}

	return &Supervisor{
		sessions:         map[string]*sessionRecord{},
		processFactory:   processFactory,
		ripgrepResolver:  ripgrepResolver,
		terminateTimeout: terminateTimeout,
		now:              now,
		emit:             emit,
		chunkSize:        chunkSize,
		resultLimit:      resultLimit,
	}
}

func (s *Supervisor) Start(ctx context.Context, cmd contracts.SearchStartCommand) error {
	command, err := s.ripgrepResolver()
	if err != nil {
		unavailable, message := classifySearchStartError(err)
		state := contracts.SearchFailureStateError
		if unavailable {
			state = contracts.SearchFailureStateUnavailable
		}
		return s.emit(ctx, contracts.SearchFailedEvent{
			Type:        MessageTypeLifecycle,
			Action:      contracts.SearchLifecycleActionFailed,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			SessionID:   cmd.SessionID,
			State:       state,
			Message:     message,
			ExitCode:    nil,
			FailedAt:    s.timestamp(),
		})
	}

	spec := ProcessSpec{
		WorkspaceID: cmd.WorkspaceID,
		SessionID:   cmd.SessionID,
		Command:     command,
		Args:        BuildRipgrepArgs(cmd.Query, cmd.Options),
		Cwd:         cmd.Cwd,
	}

	stderr := &limitedBuffer{limit: maxStderrBytes}
	process, err := s.processFactory(spec)
	if err != nil {
		unavailable, message := classifySearchStartError(err)
		state := contracts.SearchFailureStateError
		if unavailable {
			state = contracts.SearchFailureStateUnavailable
		}
		return s.emit(ctx, contracts.SearchFailedEvent{
			Type:        MessageTypeLifecycle,
			Action:      contracts.SearchLifecycleActionFailed,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			SessionID:   cmd.SessionID,
			State:       state,
			Message:     message,
			ExitCode:    nil,
			FailedAt:    s.timestamp(),
		})
	}

	record := &sessionRecord{
		spec:       spec,
		requestID:  cmd.RequestID,
		process:    process,
		stderrDone: make(chan struct{}),
		finished:   make(chan struct{}),
		stderr:     stderr,
		startedAt:  s.timestamp(),
		files:      map[string]struct{}{},
	}

	s.mu.Lock()
	if existing := s.sessions[cmd.SessionID]; existing != nil {
		s.mu.Unlock()
		discardStartedProcess(process)
		return s.emit(ctx, contracts.SearchFailedEvent{
			Type:        MessageTypeLifecycle,
			Action:      contracts.SearchLifecycleActionFailed,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			SessionID:   cmd.SessionID,
			State:       contracts.SearchFailureStateError,
			Message:     fmt.Sprintf("search session %q is already running", cmd.SessionID),
			ExitCode:    nil,
			FailedAt:    s.timestamp(),
		})
	}
	s.sessions[cmd.SessionID] = record
	s.mu.Unlock()

	go func() {
		defer close(record.stderrDone)
		_, _ = io.Copy(stderr, process.Stderr())
	}()

	if err := s.emit(ctx, contracts.SearchStartedReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionStarted,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		SessionID:   cmd.SessionID,
		RipgrepPath: command,
		StartedAt:   record.startedAt,
	}); err != nil {
		s.terminate(record)
		go s.runSession(record)
		return err
	}

	go s.runSession(record)
	return nil
}

func (s *Supervisor) Cancel(ctx context.Context, cmd contracts.SearchCancelCommand) error {
	record := s.getRecord(cmd.SessionID)
	if record == nil || record.spec.WorkspaceID != cmd.WorkspaceID {
		return s.emit(ctx, contracts.SearchCanceledEvent{
			Type:        MessageTypeLifecycle,
			Action:      contracts.SearchLifecycleActionCanceled,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			SessionID:   cmd.SessionID,
			MatchCount:  0,
			FileCount:   0,
			Truncated:   false,
			CanceledAt:  s.timestamp(),
			Message:     "search session was not running",
		})
	}

	record.markCanceling(cmd.RequestID, "search canceled by request")
	s.terminate(record)
	return nil
}

func (s *Supervisor) ShutdownAll(ctx context.Context, workspaceID *contracts.WorkspaceID) error {
	records := s.snapshotRecords(workspaceID)
	for _, record := range records {
		record.markCanceling("", "search canceled by sidecar shutdown")
		s.terminate(record)
	}
	for _, record := range records {
		select {
		case <-record.finished:
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.terminateTimeout * 2):
			_ = record.process.Kill()
		}
	}
	return nil
}

func (s *Supervisor) runSession(record *sessionRecord) {
	stdoutDrained, parseErr := s.scanResults(record)
	if parseErr != nil {
		s.terminate(record)
	}
	if !stdoutDrained {
		drain(record.process.Stdout())
	}
	<-record.stderrDone
	exit := record.process.Wait()
	s.removeRecord(record)
	close(record.finished)

	if record.isCanceling() {
		s.emitBackground(record.canceledEvent(s.timestamp()))
		return
	}

	if parseErr != nil {
		s.emitBackground(record.failedEvent(contracts.SearchFailureStateError, parseErr.Error(), exit, s.timestamp()))
		return
	}

	if isRipgrepSuccess(exit) || record.isTruncated() {
		s.emitBackground(record.completedEvent(exit, s.timestamp()))
		return
	}

	message := strings.TrimSpace(record.stderr.String())
	if message == "" && exit.Err != nil {
		message = exit.Err.Error()
	}
	if message == "" {
		message = "ripgrep exited with an error"
	}
	s.emitBackground(record.failedEvent(contracts.SearchFailureStateError, message, exit, s.timestamp()))
}

func (s *Supervisor) scanResults(record *sessionRecord) (bool, error) {
	scanner := bufio.NewScanner(record.process.Stdout())
	scanner.Buffer(make([]byte, 64*1024), maxRipgrepJSONLineBytes)
	chunk := make([]contracts.SearchResult, 0, s.chunkSize)

	flush := func(truncated bool) {
		if len(chunk) == 0 {
			return
		}
		s.emitBackground(contracts.SearchResultChunkMessage{
			Type:        MessageTypeRelay,
			Direction:   contracts.SearchRelayDirectionServerToClient,
			Kind:        contracts.SearchRelayKindResultChunk,
			WorkspaceID: record.spec.WorkspaceID,
			SessionID:   record.spec.SessionID,
			Seq:         int(s.relaySeq.Add(1)),
			Results:     append([]contracts.SearchResult(nil), chunk...),
			Truncated:   truncated,
		})
		chunk = chunk[:0]
	}

	for scanner.Scan() {
		result, err := ParseRipgrepJSONLine(scanner.Bytes())
		if err != nil {
			return false, fmt.Errorf("parse ripgrep json: %w", err)
		}
		if result == nil {
			continue
		}

		if record.resultCount() >= s.resultLimit {
			record.markTruncated()
			flush(true)
			s.terminate(record)
			break
		}

		record.addResult(result.Path)
		chunk = append(chunk, *result)
		if record.resultCount() >= s.resultLimit {
			record.markTruncated()
			flush(true)
			s.terminate(record)
			break
		}
		if len(chunk) >= s.chunkSize {
			flush(false)
		}
	}

	if err := scanner.Err(); err != nil && !record.isCanceling() && !record.isTruncated() {
		return false, err
	}
	flush(record.isTruncated())
	return !record.isTruncated(), nil
}

func (s *Supervisor) terminate(record *sessionRecord) {
	record.mu.Lock()
	if record.terminationSet {
		record.mu.Unlock()
		return
	}
	record.terminationSet = true
	record.mu.Unlock()

	_ = record.process.Signal(syscall.SIGTERM)
	go func() {
		time.Sleep(s.terminateTimeout)
		if s.getRecord(record.spec.SessionID) == record {
			_ = record.process.Kill()
		}
	}()
}

func (s *Supervisor) getRecord(sessionID string) *sessionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[sessionID]
}

func (s *Supervisor) snapshotRecords(workspaceID *contracts.WorkspaceID) []*sessionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]*sessionRecord, 0, len(s.sessions))
	for _, record := range s.sessions {
		if workspaceID != nil && record.spec.WorkspaceID != *workspaceID {
			continue
		}
		records = append(records, record)
	}
	return records
}

func (s *Supervisor) removeRecord(record *sessionRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[record.spec.SessionID] == record {
		delete(s.sessions, record.spec.SessionID)
	}
}

func (s *Supervisor) timestamp() string {
	return s.now().UTC().Format(time.RFC3339Nano)
}

func (s *Supervisor) emitBackground(msg any) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultEmitTimeout)
	defer cancel()
	_ = s.emit(ctx, msg)
}

func (r *sessionRecord) markCanceling(requestID string, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.canceling = true
	r.cancelRequest = requestID
	r.cancelMessage = message
}

func (r *sessionRecord) isCanceling() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.canceling
}

func (r *sessionRecord) markTruncated() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.truncated = true
}

func (r *sessionRecord) isTruncated() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.truncated
}

func (r *sessionRecord) addResult(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.matchCount++
	r.files[path] = struct{}{}
}

func (r *sessionRecord) resultCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.matchCount
}

func (r *sessionRecord) stats() (int, int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.matchCount, len(r.files), r.truncated
}

func (r *sessionRecord) completedEvent(exit ProcessExit, at string) contracts.SearchCompletedEvent {
	matchCount, fileCount, truncated := r.stats()
	return contracts.SearchCompletedEvent{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionCompleted,
		RequestID:   r.requestID,
		WorkspaceID: r.spec.WorkspaceID,
		SessionID:   r.spec.SessionID,
		MatchCount:  matchCount,
		FileCount:   fileCount,
		Truncated:   truncated,
		ExitCode:    exit.ExitCode,
		CompletedAt: at,
	}
}

func (r *sessionRecord) failedEvent(state contracts.SearchFailureState, message string, exit ProcessExit, at string) contracts.SearchFailedEvent {
	return contracts.SearchFailedEvent{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionFailed,
		RequestID:   r.requestID,
		WorkspaceID: r.spec.WorkspaceID,
		SessionID:   r.spec.SessionID,
		State:       state,
		Message:     message,
		ExitCode:    exit.ExitCode,
		FailedAt:    at,
	}
}

func (r *sessionRecord) canceledEvent(at string) contracts.SearchCanceledEvent {
	matchCount, fileCount, truncated := r.stats()
	r.mu.Lock()
	requestID := r.cancelRequest
	message := r.cancelMessage
	r.mu.Unlock()
	return contracts.SearchCanceledEvent{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionCanceled,
		RequestID:   requestID,
		WorkspaceID: r.spec.WorkspaceID,
		SessionID:   r.spec.SessionID,
		MatchCount:  matchCount,
		FileCount:   fileCount,
		Truncated:   truncated,
		CanceledAt:  at,
		Message:     message,
	}
}

func isRipgrepSuccess(exit ProcessExit) bool {
	if exit.Signal != nil {
		return false
	}
	if exit.ExitCode == nil {
		return exit.Err == nil
	}
	return *exit.ExitCode == 0 || *exit.ExitCode == 1
}

type limitedBuffer struct {
	mu    sync.Mutex
	limit int
	buf   bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.limit <= 0 {
		return len(p), nil
	}
	remaining := b.limit - b.buf.Len()
	if remaining > 0 {
		if len(p) > remaining {
			_, _ = b.buf.Write(p[:remaining])
		} else {
			_, _ = b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func discardStartedProcess(process ManagedProcess) {
	_ = process.Kill()
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			drain(process.Stdout())
		}()
		go func() {
			defer wg.Done()
			drain(process.Stderr())
		}()
		wg.Wait()
		_ = process.Wait()
	}()
}

func drain(reader io.Reader) {
	_, _ = io.Copy(io.Discard, reader)
}
