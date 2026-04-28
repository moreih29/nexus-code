package lsp

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

func TestSupervisorRestartLogicStopsOldProcessAndStartsNew(t *testing.T) {
	factory := &fakeProcessFactory{}
	var emitted []any
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory:   factory.New,
		TerminateTimeout: 5 * time.Millisecond,
		Now: func() time.Time {
			return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC)
		},
		Emit: func(_ context.Context, msg any) error {
			emitted = append(emitted, msg)
			return nil
		},
	})

	if err := supervisor.StartServer(context.Background(), startCommand("req_start")); err != nil {
		t.Fatalf("start server: %v", err)
	}
	if err := supervisor.RestartServer(context.Background(), contracts.LspRestartServerCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionRestartServer,
		RequestID:   "req_restart",
		WorkspaceID: "ws_lsp_go",
		ServerID:    "ws_lsp_go:go",
		Language:    contracts.LspLanguageGo,
		Command:     "gopls",
		Args:        []string{"serve"},
		Cwd:         "/workspace",
		ServerName:  "gopls",
	}); err != nil {
		t.Fatalf("restart server: %v", err)
	}

	if len(factory.processes) != 2 {
		t.Fatalf("expected 2 processes, got %d", len(factory.processes))
	}
	if got := factory.processes[0].signals; len(got) != 1 || got[0] != "terminated" {
		t.Fatalf("expected old process to receive SIGTERM, got %#v", got)
	}
	startedReplies := countEmitted[contracts.LspServerStartedReply](emitted)
	if startedReplies != 2 {
		t.Fatalf("expected 2 started replies, got %d", startedReplies)
	}
}

func TestSupervisorRelaysStdoutPayloadWithoutReframing(t *testing.T) {
	factory := &fakeProcessFactory{}
	relayPayloads := make(chan string, 1)
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory: factory.New,
		Emit: func(_ context.Context, msg any) error {
			if relay, ok := msg.(contracts.LspServerPayloadMessage); ok {
				relayPayloads <- relay.Payload
			}
			return nil
		},
	})

	if err := supervisor.StartServer(context.Background(), startCommand("req_start")); err != nil {
		t.Fatalf("start server: %v", err)
	}
	payload := "Content-Length: 47\r\n\r\n{\"jsonrpc\":\"2.0\",\"method\":\"window/logMessage\"}"
	factory.processes[0].WriteStdout(payload)

	select {
	case got := <-relayPayloads:
		if got != payload {
			t.Fatalf("relay payload changed:\nwant %q\n got %q", payload, got)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for relay payload")
	}
}

func TestSupervisorStopUsesSigtermThenSigkillAfterTimeout(t *testing.T) {
	factory := &fakeProcessFactory{ignoreTerminate: true}
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory:   factory.New,
		TerminateTimeout: 5 * time.Millisecond,
		Now: func() time.Time {
			return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC)
		},
	})

	if err := supervisor.StartServer(context.Background(), startCommand("req_start")); err != nil {
		t.Fatalf("start server: %v", err)
	}
	if err := supervisor.StopServer(context.Background(), contracts.LspStopServerCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionStopServer,
		RequestID:   "req_stop",
		WorkspaceID: "ws_lsp_go",
		ServerID:    "ws_lsp_go:go",
		Language:    contracts.LspLanguageGo,
		ServerName:  "gopls",
		Reason:      contracts.LspServerStopReasonAppShutdown,
	}); err != nil {
		t.Fatalf("stop server: %v", err)
	}

	got := factory.processes[0].signals
	want := []string{"terminated", "killed"}
	if len(got) != len(want) {
		t.Fatalf("signals length mismatch: want %#v, got %#v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("signals mismatch: want %#v, got %#v", want, got)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if len(factory.processes) != 1 {
		t.Fatalf("explicit stop_server restarted process: got %d processes", len(factory.processes))
	}
}

func TestSupervisorDefaultTerminateTimeoutIsFiveSeconds(t *testing.T) {
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory: (&fakeProcessFactory{}).New,
	})

	if supervisor.terminateTimeout != 5*time.Second {
		t.Fatalf("terminateTimeout = %s, want 5s", supervisor.terminateTimeout)
	}
}

func TestSupervisorAutoRestartsCrashedExecProcess(t *testing.T) {
	tempDir := t.TempDir()
	countFile := tempDir + "/fake-lsp-count"
	if err := os.WriteFile(countFile, []byte("0"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEXUS_SUPERVISOR_FAKE_LSP", "1")
	t.Setenv("NEXUS_SUPERVISOR_FAKE_LSP_COUNT", countFile)
	t.Setenv("NEXUS_SUPERVISOR_FAKE_LSP_CRASHES", "3")

	emitted := make(chan any, 32)
	supervisor := NewSupervisor(SupervisorOptions{
		TerminateTimeout: 50 * time.Millisecond,
		Emit: func(_ context.Context, msg any) error {
			emitted <- msg
			return nil
		},
	})
	cmd := startCommand("req_start")
	cmd.Command = os.Args[0]
	cmd.Args = []string{"-test.run=TestSupervisorFakeLspHelperProcess", "--"}
	cmd.Cwd = tempDir
	cmd.ServerName = "fake-lsp"

	if err := supervisor.StartServer(context.Background(), cmd); err != nil {
		t.Fatalf("start server: %v", err)
	}

	messages := collectEmittedUntil(t, emitted, 5*time.Second, func(messages []any) bool {
		return countEmitted[contracts.LspServerStartedReply](messages) >= 4 &&
			countEmitted[contracts.LspServerStoppedEvent](messages) >= 3
	})
	started := filterEmitted[contracts.LspServerStartedReply](messages)
	stopped := filterEmitted[contracts.LspServerStoppedEvent](messages)
	if len(started) < 4 {
		t.Fatalf("expected initial start plus 3 replacements, got %d starts", len(started))
	}
	if len(stopped) < 3 {
		t.Fatalf("expected 3 crash stop events, got %d stops", len(stopped))
	}
	for i, event := range stopped[:3] {
		if event.Reason != contracts.LspServerStopReasonRestart {
			t.Fatalf("stopped[%d].Reason = %q, want restart", i, event.Reason)
		}
		if event.ExitCode == nil || *event.ExitCode != 42 {
			t.Fatalf("stopped[%d].ExitCode = %v, want 42", i, event.ExitCode)
		}
	}

	if err := supervisor.HealthCheck(context.Background(), contracts.LspHealthCheckCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionHealthCheck,
		RequestID:   "req_health",
		WorkspaceID: cmd.WorkspaceID,
		ServerID:    cmd.ServerID,
	}); err != nil {
		t.Fatalf("health check: %v", err)
	}
	health := waitForEmitted[contracts.LspServerHealthReply](t, emitted, time.Second)
	if health.State != contracts.LspServerStateRunning {
		t.Fatalf("health state = %q, want running", health.State)
	}
	if health.PID == 0 {
		t.Fatal("health PID = 0, want replacement process PID")
	}

	if err := supervisor.StopServer(context.Background(), contracts.LspStopServerCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionStopServer,
		RequestID:   "req_stop",
		WorkspaceID: cmd.WorkspaceID,
		ServerID:    cmd.ServerID,
		Language:    cmd.Language,
		ServerName:  cmd.ServerName,
		Reason:      contracts.LspServerStopReasonAppShutdown,
	}); err != nil {
		t.Fatalf("stop server: %v", err)
	}
	assertNoStartedEvent(t, emitted, 150*time.Millisecond)
}

func TestSupervisorStopAllDoesNotAutoRestart(t *testing.T) {
	factory := &fakeProcessFactory{}
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory:   factory.New,
		TerminateTimeout: 5 * time.Millisecond,
	})

	if err := supervisor.StartServer(context.Background(), startCommand("req_start")); err != nil {
		t.Fatalf("start server: %v", err)
	}
	workspaceID := contracts.WorkspaceID("ws_lsp_go")
	if err := supervisor.StopAll(context.Background(), contracts.LspStopAllServersCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionStopAll,
		RequestID:   "req_stop_all",
		WorkspaceID: &workspaceID,
		Reason:      contracts.LspServerStopReasonAppShutdown,
	}); err != nil {
		t.Fatalf("stop all: %v", err)
	}

	time.Sleep(20 * time.Millisecond)
	if len(factory.processes) != 1 {
		t.Fatalf("explicit stop_all restarted process: got %d processes", len(factory.processes))
	}
}

func startCommand(requestID string) contracts.LspStartServerCommand {
	return contracts.LspStartServerCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.LspLifecycleActionStartServer,
		RequestID:   requestID,
		WorkspaceID: "ws_lsp_go",
		ServerID:    "ws_lsp_go:go",
		Language:    contracts.LspLanguageGo,
		Command:     "gopls",
		Args:        []string{"serve"},
		Cwd:         "/workspace",
		ServerName:  "gopls",
	}
}

func countEmitted[T any](messages []any) int {
	count := 0
	for _, message := range messages {
		if _, ok := message.(T); ok {
			count++
		}
	}
	return count
}

func filterEmitted[T any](messages []any) []T {
	filtered := []T{}
	for _, message := range messages {
		if typed, ok := message.(T); ok {
			filtered = append(filtered, typed)
		}
	}
	return filtered
}

func collectEmittedUntil(t *testing.T, emitted <-chan any, timeout time.Duration, done func([]any) bool) []any {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	messages := []any{}
	for {
		if done(messages) {
			return messages
		}
		select {
		case message := <-emitted:
			messages = append(messages, message)
		case <-timer.C:
			t.Fatalf("timed out waiting for emitted messages; got %#v", messages)
		}
	}
}

func waitForEmitted[T any](t *testing.T, emitted <-chan any, timeout time.Duration) T {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case message := <-emitted:
			if typed, ok := message.(T); ok {
				return typed
			}
		case <-timer.C:
			var zero T
			t.Fatalf("timed out waiting for emitted %T", zero)
		}
	}
}

func assertNoStartedEvent(t *testing.T, emitted <-chan any, duration time.Duration) {
	t.Helper()
	timer := time.NewTimer(duration)
	defer timer.Stop()

	for {
		select {
		case message := <-emitted:
			if _, ok := message.(contracts.LspServerStartedReply); ok {
				t.Fatalf("unexpected started event after explicit stop: %#v", message)
			}
		case <-timer.C:
			return
		}
	}
}

func TestSupervisorFakeLspHelperProcess(t *testing.T) {
	if os.Getenv("NEXUS_SUPERVISOR_FAKE_LSP") != "1" {
		return
	}

	countFile := os.Getenv("NEXUS_SUPERVISOR_FAKE_LSP_COUNT")
	crashLimit, err := strconv.Atoi(os.Getenv("NEXUS_SUPERVISOR_FAKE_LSP_CRASHES"))
	if err != nil {
		os.Exit(2)
	}
	countBytes, _ := os.ReadFile(countFile)
	count, _ := strconv.Atoi(string(countBytes))
	count++
	if err := os.WriteFile(countFile, []byte(strconv.Itoa(count)), 0o600); err != nil {
		os.Exit(2)
	}
	if count <= crashLimit {
		os.Exit(42)
	}

	select {}
}

type fakeProcessFactory struct {
	ignoreTerminate bool
	processes       []*fakeProcess
}

func (f *fakeProcessFactory) New(spec ProcessSpec) (ManagedProcess, error) {
	process := newFakeProcess(1000+len(f.processes), f.ignoreTerminate)
	process.spec = spec
	f.processes = append(f.processes, process)
	return process, nil
}

type fakeProcess struct {
	spec            ProcessSpec
	pid             int
	stdinReader     *io.PipeReader
	stdinWriter     *io.PipeWriter
	stdoutReader    *io.PipeReader
	stdoutWriter    *io.PipeWriter
	stderrReader    *io.PipeReader
	stderrWriter    *io.PipeWriter
	ignoreTerminate bool

	mu      sync.Mutex
	signals []string
	exitCh  chan ProcessExit
	exited  bool
}

func newFakeProcess(pid int, ignoreTerminate bool) *fakeProcess {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()
	return &fakeProcess{
		pid:             pid,
		stdinReader:     stdinReader,
		stdinWriter:     stdinWriter,
		stdoutReader:    stdoutReader,
		stdoutWriter:    stdoutWriter,
		stderrReader:    stderrReader,
		stderrWriter:    stderrWriter,
		ignoreTerminate: ignoreTerminate,
		exitCh:          make(chan ProcessExit, 1),
	}
}

func (p *fakeProcess) PID() int              { return p.pid }
func (p *fakeProcess) Stdin() io.WriteCloser { return p.stdinWriter }
func (p *fakeProcess) Stdout() io.Reader     { return p.stdoutReader }
func (p *fakeProcess) Stderr() io.Reader     { return p.stderrReader }

func (p *fakeProcess) Signal(signal os.Signal) error {
	p.mu.Lock()
	p.signals = append(p.signals, signalName(signal))
	ignoreTerminate := p.ignoreTerminate
	p.mu.Unlock()
	if !ignoreTerminate {
		code := 0
		p.finish(ProcessExit{ExitCode: &code})
	}
	return nil
}

func (p *fakeProcess) Kill() error {
	p.mu.Lock()
	p.signals = append(p.signals, "killed")
	p.mu.Unlock()
	signal := "SIGKILL"
	p.finish(ProcessExit{Signal: &signal})
	return nil
}

func (p *fakeProcess) Wait() ProcessExit {
	return <-p.exitCh
}

func (p *fakeProcess) WriteStdout(payload string) {
	_, _ = io.WriteString(p.stdoutWriter, payload)
}

func (p *fakeProcess) finish(exit ProcessExit) {
	p.mu.Lock()
	if p.exited {
		p.mu.Unlock()
		return
	}
	p.exited = true
	p.mu.Unlock()
	_ = p.stdoutWriter.Close()
	_ = p.stderrWriter.Close()
	_ = p.stdinReader.CloseWithError(errors.New("process exited"))
	p.exitCh <- exit
}

func signalName(signal any) string {
	name := ""
	if stringer, ok := signal.(interface{ String() string }); ok {
		name = stringer.String()
	}
	if name == "terminated" || name == "killed" {
		return name
	}
	return name
}
