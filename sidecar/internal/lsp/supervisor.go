package lsp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

const (
	MessageTypeLifecycle = "lsp/lifecycle"
	MessageTypeRelay     = "lsp/relay"

	defaultTerminateTimeout = 5 * time.Second
	defaultEmitTimeout      = 2 * time.Second
)

type EmitFunc func(context.Context, any) error

type SupervisorOptions struct {
	ProcessFactory   ProcessFactory
	TerminateTimeout time.Duration
	Now              func() time.Time
	Emit             EmitFunc
}

type Supervisor struct {
	mu               sync.Mutex
	servers          map[string]*serverRecord
	processFactory   ProcessFactory
	terminateTimeout time.Duration
	now              func() time.Time
	emit             EmitFunc
	relaySeq         atomic.Int64
	restartSeq       atomic.Int64
}

type ProcessSpec struct {
	WorkspaceID contracts.WorkspaceID
	ServerID    string
	Language    contracts.LspLanguage
	Command     string
	Args        []string
	Cwd         string
	ServerName  string
}

type ProcessExit struct {
	ExitCode *int
	Signal   *string
	Err      error
}

type ManagedProcess interface {
	PID() int
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	Signal(os.Signal) error
	Kill() error
	Wait() ProcessExit
}

type ProcessFactory func(ProcessSpec) (ManagedProcess, error)

type serverRecord struct {
	spec    ProcessSpec
	process ManagedProcess
	done    chan ProcessExit

	mu       sync.Mutex
	stopping bool
}

func NewSupervisor(options SupervisorOptions) *Supervisor {
	processFactory := options.ProcessFactory
	if processFactory == nil {
		processFactory = NewExecProcess
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

	return &Supervisor{
		servers:          map[string]*serverRecord{},
		processFactory:   processFactory,
		terminateTimeout: terminateTimeout,
		now:              now,
		emit:             emit,
	}
}

func (s *Supervisor) StartServer(ctx context.Context, cmd contracts.LspStartServerCommand) error {
	spec := ProcessSpec{
		WorkspaceID: cmd.WorkspaceID,
		ServerID:    cmd.ServerID,
		Language:    cmd.Language,
		Command:     cmd.Command,
		Args:        append([]string(nil), cmd.Args...),
		Cwd:         cmd.Cwd,
		ServerName:  cmd.ServerName,
	}

	record, err := s.startProcess(spec)
	if err != nil {
		state, message := classifyStartError(spec.Command, spec.ServerName, err)
		return s.emit(ctx, contracts.LspServerStartFailedReply{
			Type:        MessageTypeLifecycle,
			Action:      contracts.LspLifecycleActionServerStartFailed,
			RequestID:   cmd.RequestID,
			WorkspaceID: spec.WorkspaceID,
			ServerID:    spec.ServerID,
			Language:    spec.Language,
			ServerName:  spec.ServerName,
			State:       state,
			Message:     message,
		})
	}

	return s.emit(ctx, s.startedReply(record, cmd.RequestID))
}

func (s *Supervisor) startProcess(spec ProcessSpec) (*serverRecord, error) {
	s.mu.Lock()
	if existing := s.servers[spec.ServerID]; existing != nil {
		s.mu.Unlock()
		return existing, nil
	}
	s.mu.Unlock()

	process, err := s.processFactory(spec)
	if err != nil {
		return nil, err
	}

	record := &serverRecord{
		spec:    spec,
		process: process,
		done:    make(chan ProcessExit, 1),
	}

	s.mu.Lock()
	if existing := s.servers[spec.ServerID]; existing != nil {
		s.mu.Unlock()
		discardStartedProcess(process)
		return existing, nil
	}
	s.servers[spec.ServerID] = record
	s.mu.Unlock()

	go s.relayStdout(record)
	go drain(record.process.Stderr())
	go s.waitForExit(record)

	return record, nil
}

func (s *Supervisor) startedReply(record *serverRecord, requestID string) contracts.LspServerStartedReply {
	return contracts.LspServerStartedReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionServerStarted,
		RequestID:   requestID,
		WorkspaceID: record.spec.WorkspaceID,
		ServerID:    record.spec.ServerID,
		Language:    record.spec.Language,
		ServerName:  record.spec.ServerName,
		PID:         record.process.PID(),
	}
}

func (s *Supervisor) StopServer(ctx context.Context, cmd contracts.LspStopServerCommand) error {
	record := s.getRecord(cmd.ServerID)
	if record == nil {
		return s.emit(ctx, contracts.LspServerStoppedEvent{
			Type:        MessageTypeLifecycle,
			Action:      contracts.LspLifecycleActionServerStopped,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			ServerID:    cmd.ServerID,
			Language:    cmd.Language,
			ServerName:  cmd.ServerName,
			Reason:      cmd.Reason,
			ExitCode:    nil,
			Signal:      nil,
			StoppedAt:   s.timestamp(),
			Message:     "server was not running",
		})
	}

	event := s.stopRecord(record, cmd.RequestID, cmd.Reason)
	return s.emit(ctx, event)
}

func (s *Supervisor) RestartServer(ctx context.Context, cmd contracts.LspRestartServerCommand) error {
	if record := s.getRecord(cmd.ServerID); record != nil {
		event := s.stopRecord(record, "", contracts.LspServerStopReasonRestart)
		s.emitBackground(event)
	}

	return s.StartServer(ctx, contracts.LspStartServerCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionStartServer,
		RequestID:   cmd.RequestID,
		WorkspaceID: cmd.WorkspaceID,
		ServerID:    cmd.ServerID,
		Language:    cmd.Language,
		Command:     cmd.Command,
		Args:        cmd.Args,
		Cwd:         cmd.Cwd,
		ServerName:  cmd.ServerName,
	})
}

func (s *Supervisor) HealthCheck(ctx context.Context, cmd contracts.LspHealthCheckCommand) error {
	record := s.getRecord(cmd.ServerID)
	if record == nil {
		return s.emit(ctx, contracts.LspServerHealthReply{
			Type:        MessageTypeLifecycle,
			Action:      contracts.LspLifecycleActionServerHealth,
			RequestID:   cmd.RequestID,
			WorkspaceID: cmd.WorkspaceID,
			ServerID:    cmd.ServerID,
			State:       contracts.LspServerStateStopped,
			Message:     "server is not running",
		})
	}

	return s.emit(ctx, contracts.LspServerHealthReply{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionServerHealth,
		RequestID:   cmd.RequestID,
		WorkspaceID: record.spec.WorkspaceID,
		ServerID:    record.spec.ServerID,
		State:       contracts.LspServerStateRunning,
		PID:         record.process.PID(),
	})
}

func (s *Supervisor) StopAll(ctx context.Context, cmd contracts.LspStopAllServersCommand) error {
	records := s.snapshotRecords(cmd.WorkspaceID)
	events := s.stopRecords(records, cmd.Reason)
	stoppedServerIDs := make([]string, 0, len(events))
	for _, event := range events {
		stoppedServerIDs = append(stoppedServerIDs, event.ServerID)
		if err := s.emit(ctx, event); err != nil {
			return err
		}
	}

	return s.emit(ctx, contracts.LspStopAllServersReply{
		Type:               MessageTypeLifecycle,
		Action:             contracts.LspLifecycleActionStopAllStopped,
		RequestID:          cmd.RequestID,
		WorkspaceID:        cmd.WorkspaceID,
		StoppedServerIDs:   stoppedServerIDs,
		ExpectedCloseCodes: append([]int(nil), cmd.ExpectedCloseCodes...),
	})
}

func (s *Supervisor) ShutdownAll(ctx context.Context, workspaceID *contracts.WorkspaceID, reason contracts.LspServerStopReason) error {
	records := s.snapshotRecords(workspaceID)
	for _, event := range s.stopRecords(records, reason) {
		if err := s.emit(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (s *Supervisor) stopRecords(records []*serverRecord, reason contracts.LspServerStopReason) []contracts.LspServerStoppedEvent {
	events := make([]contracts.LspServerStoppedEvent, len(records))
	var wg sync.WaitGroup
	for index, record := range records {
		wg.Add(1)
		go func() {
			defer wg.Done()
			events[index] = s.stopRecord(record, "", reason)
		}()
	}
	wg.Wait()
	return events
}

func (s *Supervisor) RelayClientPayload(ctx context.Context, msg contracts.LspClientPayloadMessage) error {
	record := s.getRecord(msg.ServerID)
	if record == nil || record.spec.WorkspaceID != msg.WorkspaceID {
		return fmt.Errorf("lsp server %q is not running", msg.ServerID)
	}

	_, err := io.WriteString(record.process.Stdin(), msg.Payload)
	return err
}

func (s *Supervisor) getRecord(serverID string) *serverRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.servers[serverID]
}

func (s *Supervisor) snapshotRecords(workspaceID *contracts.WorkspaceID) []*serverRecord {
	s.mu.Lock()
	defer s.mu.Unlock()

	records := make([]*serverRecord, 0, len(s.servers))
	for _, record := range s.servers {
		if workspaceID != nil && record.spec.WorkspaceID != *workspaceID {
			continue
		}
		records = append(records, record)
	}
	return records
}

func (s *Supervisor) relayStdout(record *serverRecord) {
	buf := make([]byte, 32*1024)
	for {
		n, err := record.process.Stdout().Read(buf)
		if n > 0 {
			seq := int(s.relaySeq.Add(1))
			s.emitBackground(contracts.LspServerPayloadMessage{
				Type:        MessageTypeRelay,
				Direction:   contracts.LspRelayDirectionServerToClient,
				WorkspaceID: record.spec.WorkspaceID,
				ServerID:    record.spec.ServerID,
				Seq:         seq,
				Payload:     string(buf[:n]),
			})
		}
		if err != nil {
			return
		}
	}
}

func (s *Supervisor) waitForExit(record *serverRecord) {
	exit := record.process.Wait()
	record.done <- exit

	record.mu.Lock()
	stopping := record.stopping
	record.mu.Unlock()
	if stopping {
		return
	}

	s.mu.Lock()
	if s.servers[record.spec.ServerID] != record {
		s.mu.Unlock()
		return
	}
	delete(s.servers, record.spec.ServerID)
	s.mu.Unlock()

	message := ""
	if exit.Err != nil {
		message = exit.Err.Error()
	}
	s.emitBackground(s.stoppedEvent(record, "", contracts.LspServerStopReasonRestart, exit, message))
	s.restartExitedProcess(record.spec)
}

func (s *Supervisor) restartExitedProcess(spec ProcessSpec) {
	requestID := fmt.Sprintf("auto-restart-%s-%d", spec.ServerID, s.restartSeq.Add(1))
	record, err := s.startProcess(spec)
	if err != nil {
		state, message := classifyStartError(spec.Command, spec.ServerName, err)
		s.emitBackground(contracts.LspServerStartFailedReply{
			Type:        MessageTypeLifecycle,
			Action:      contracts.LspLifecycleActionServerStartFailed,
			RequestID:   requestID,
			WorkspaceID: spec.WorkspaceID,
			ServerID:    spec.ServerID,
			Language:    spec.Language,
			ServerName:  spec.ServerName,
			State:       state,
			Message:     message,
		})
		return
	}

	s.emitBackground(s.startedReply(record, requestID))
}

func (s *Supervisor) stopRecord(record *serverRecord, requestID string, reason contracts.LspServerStopReason) contracts.LspServerStoppedEvent {
	record.mu.Lock()
	record.stopping = true
	record.mu.Unlock()

	_ = record.process.Stdin().Close()
	_ = record.process.Signal(syscall.SIGTERM)

	var exit ProcessExit
	select {
	case exit = <-record.done:
	case <-time.After(s.terminateTimeout):
		_ = record.process.Kill()
		select {
		case exit = <-record.done:
		case <-time.After(s.terminateTimeout):
			signal := "SIGKILL"
			exit = ProcessExit{Signal: &signal, Err: errors.New("process did not exit after SIGKILL")}
		}
	}

	s.mu.Lock()
	if s.servers[record.spec.ServerID] == record {
		delete(s.servers, record.spec.ServerID)
	}
	s.mu.Unlock()

	message := ""
	if exit.Err != nil {
		message = exit.Err.Error()
	}
	return s.stoppedEvent(record, requestID, reason, exit, message)
}

func (s *Supervisor) stoppedEvent(
	record *serverRecord,
	requestID string,
	reason contracts.LspServerStopReason,
	exit ProcessExit,
	message string,
) contracts.LspServerStoppedEvent {
	return contracts.LspServerStoppedEvent{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionServerStopped,
		RequestID:   requestID,
		WorkspaceID: record.spec.WorkspaceID,
		ServerID:    record.spec.ServerID,
		Language:    record.spec.Language,
		ServerName:  record.spec.ServerName,
		Reason:      reason,
		ExitCode:    exit.ExitCode,
		Signal:      exit.Signal,
		StoppedAt:   s.timestamp(),
		Message:     message,
	}
}

func (s *Supervisor) emitBackground(msg any) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultEmitTimeout)
	defer cancel()
	_ = s.emit(ctx, msg)
}

func (s *Supervisor) timestamp() string {
	return s.now().UTC().Format(time.RFC3339Nano)
}

func classifyStartError(command string, serverName string, err error) (contracts.LspServerState, string) {
	if errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err) {
		return contracts.LspServerStateUnavailable, fmt.Sprintf("%s is not available on PATH.", command)
	}
	if serverName == "" {
		serverName = command
	}
	return contracts.LspServerStateError, fmt.Sprintf("%s failed to start: %v", serverName, err)
}

func drain(reader io.Reader) {
	_, _ = io.Copy(io.Discard, reader)
}

func discardStartedProcess(process ManagedProcess) {
	_ = process.Kill()
	go drain(process.Stdout())
	go drain(process.Stderr())
	go func() { _ = process.Wait() }()
}
