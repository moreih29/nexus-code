package search

import (
	"bytes"
	"context"
	"io"
	"os"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

func TestSupervisorStreamsResultChunksAndTruncatesAtLimit(t *testing.T) {
	stdout := bytes.NewBufferString(matchLine("a.go", 1) + matchLine("b.go", 2) + matchLine("c.go", 3))
	process := &fakeSearchProcess{
		stdout: stdout,
		stderr: bytes.NewBuffer(nil),
		exit:   ProcessExit{ExitCode: intPtr(0)},
	}
	emitted := make(chan any, 8)
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory: fakeFactory(process),
		RipgrepResolver: func() (string, error) {
			return "/bundle/rg", nil
		},
		Emit: func(_ context.Context, msg any) error {
			emitted <- msg
			return nil
		},
		ChunkSize:   2,
		ResultLimit: 2,
		Now:         fixedTime,
	})

	cmd := startCommand()
	if err := supervisor.Start(context.Background(), cmd); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	messages := collectSearchMessages(t, emitted, time.Second, func(messages []any) bool {
		return countSearchMessages[contracts.SearchCompletedEvent](messages) == 1
	})
	if started := filterSearchMessages[contracts.SearchStartedReply](messages); len(started) != 1 || started[0].RipgrepPath != "/bundle/rg" {
		t.Fatalf("started replies = %#v", started)
	}
	chunks := filterSearchMessages[contracts.SearchResultChunkMessage](messages)
	if len(chunks) != 1 {
		t.Fatalf("chunk len = %d, want 1; messages=%#v", len(chunks), messages)
	}
	if !chunks[0].Truncated || len(chunks[0].Results) != 2 {
		t.Fatalf("chunk = %+v", chunks[0])
	}
	completed := filterSearchMessages[contracts.SearchCompletedEvent](messages)[0]
	if !completed.Truncated || completed.MatchCount != 2 || completed.FileCount != 2 {
		t.Fatalf("completed = %+v", completed)
	}
	if got := process.signals(); len(got) == 0 || got[0] != "terminated" {
		t.Fatalf("signals = %#v, want SIGTERM after truncation", got)
	}
}

func TestSupervisorCancelTerminatesRunningSessionAndEmitsCanceled(t *testing.T) {
	stdoutReader, stdoutWriter := io.Pipe()
	trackedStdout := newEOFTrackingReader(stdoutReader)
	process := &fakeSearchProcess{
		stdout:       trackedStdout,
		stderr:       bytes.NewBuffer(nil),
		exit:         ProcessExit{Signal: stringPtr("terminated")},
		stdoutClosed: trackedStdout.eof,
		onSignal: func() {
			_ = stdoutWriter.Close()
		},
	}
	emitted := make(chan any, 8)
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory: fakeFactory(process),
		RipgrepResolver: func() (string, error) {
			return "/bundle/rg", nil
		},
		Emit: func(_ context.Context, msg any) error {
			emitted <- msg
			return nil
		},
		TerminateTimeout: 20 * time.Millisecond,
		Now:              fixedTime,
	})

	cmd := startCommand()
	if err := supervisor.Start(context.Background(), cmd); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	cancel := contracts.SearchCancelCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionCancel,
		RequestID:   "req_cancel",
		WorkspaceID: cmd.WorkspaceID,
		SessionID:   cmd.SessionID,
	}
	if err := supervisor.Cancel(context.Background(), cancel); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}

	messages := collectSearchMessages(t, emitted, time.Second, func(messages []any) bool {
		return countSearchMessages[contracts.SearchCanceledEvent](messages) == 1
	})
	canceled := filterSearchMessages[contracts.SearchCanceledEvent](messages)[0]
	if canceled.RequestID != "req_cancel" || canceled.Message != "search canceled by request" {
		t.Fatalf("canceled = %+v", canceled)
	}
	if process.waitedBeforeStdoutEOF() {
		t.Fatal("process.Wait called before stdout scanner reached EOF")
	}
}

func TestSupervisorRepeatedSearchesWaitForStdoutEOFBeforeWait(t *testing.T) {
	for i := 0; i < 25; i++ {
		stdoutReader, stdoutWriter := io.Pipe()
		trackedStdout := newEOFTrackingReader(stdoutReader)
		process := &fakeSearchProcess{
			stdout:       trackedStdout,
			stderr:       bytes.NewBuffer(nil),
			exit:         ProcessExit{ExitCode: intPtr(0)},
			stdoutClosed: trackedStdout.eof,
		}
		emitted := make(chan any, 8)
		supervisor := NewSupervisor(SupervisorOptions{
			ProcessFactory: fakeFactory(process),
			RipgrepResolver: func() (string, error) {
				return "/bundle/rg", nil
			},
			Emit: func(_ context.Context, msg any) error {
				emitted <- msg
				return nil
			},
			ChunkSize: 1,
			Now:       fixedTime,
		})

		cmd := startCommand()
		cmd.SessionID = "search-" + strconv.Itoa(i)
		cmd.RequestID = "req-" + strconv.Itoa(i)
		go func(lineNumber int) {
			_, _ = stdoutWriter.Write([]byte(matchLine("file.go", lineNumber)))
			time.Sleep(2 * time.Millisecond)
			_ = stdoutWriter.Close()
		}(i + 1)

		if err := supervisor.Start(context.Background(), cmd); err != nil {
			t.Fatalf("Start(%d) error = %v", i, err)
		}
		messages := collectSearchMessages(t, emitted, time.Second, func(messages []any) bool {
			return countSearchMessages[contracts.SearchCompletedEvent](messages) == 1
		})
		completed := filterSearchMessages[contracts.SearchCompletedEvent](messages)[0]
		if completed.MatchCount != 1 || completed.FileCount != 1 || completed.Truncated {
			t.Fatalf("completed[%d] = %+v", i, completed)
		}
		if process.waitedBeforeStdoutEOF() {
			t.Fatalf("process.Wait called before stdout EOF on iteration %d", i)
		}
	}
}

func TestSupervisorPassesRipgrepCommandSpecToProcessFactory(t *testing.T) {
	process := &fakeSearchProcess{
		stdout: bytes.NewBuffer(nil),
		stderr: bytes.NewBuffer(nil),
		exit:   ProcessExit{ExitCode: intPtr(1)},
	}
	var gotSpec ProcessSpec
	supervisor := NewSupervisor(SupervisorOptions{
		ProcessFactory: func(spec ProcessSpec) (ManagedProcess, error) {
			gotSpec = spec
			return process, nil
		},
		RipgrepResolver: func() (string, error) {
			return "/bundle/rg", nil
		},
	})

	cmd := startCommand()
	cmd.Options = contracts.SearchOptions{
		CaseSensitive: false,
		Regex:         false,
		WholeWord:     true,
		IncludeGlobs:  []string{"*.go"},
		ExcludeGlobs:  []string{"vendor/**"},
	}
	if err := supervisor.Start(context.Background(), cmd); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	wantArgs := []string{
		"--json", "--line-number", "--column", "--with-filename", "--color", "never",
		"--ignore-case", "--fixed-strings", "--word-regexp",
		"--glob", "*.go", "--glob", "!vendor/**", "--", "foo", ".",
	}
	if gotSpec.Command != "/bundle/rg" || gotSpec.Cwd != "/workspace" || !reflect.DeepEqual(gotSpec.Args, wantArgs) {
		t.Fatalf("spec = %+v, want command /bundle/rg args %#v", gotSpec, wantArgs)
	}
}

func TestResolveRipgrepPathPrefersExplicitExecutable(t *testing.T) {
	tempDir := t.TempDir()
	candidate := tempDir + "/rg"
	if err := os.WriteFile(candidate, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEXUS_RIPGREP_PATH", candidate)

	got, err := ResolveRipgrepPath()
	if err != nil {
		t.Fatalf("ResolveRipgrepPath() error = %v", err)
	}
	if got != candidate {
		t.Fatalf("ResolveRipgrepPath() = %q, want %q", got, candidate)
	}
}

func startCommand() contracts.SearchStartCommand {
	return contracts.SearchStartCommand{
		Type:        MessageTypeLifecycle,
		Action:      contracts.SearchLifecycleActionStart,
		RequestID:   "req_start",
		WorkspaceID: "ws-1",
		SessionID:   "search-1",
		Query:       "foo",
		Cwd:         "/workspace",
		Options: contracts.SearchOptions{
			CaseSensitive: true,
			Regex:         true,
			IncludeGlobs:  []string{},
			ExcludeGlobs:  []string{},
		},
	}
}

func matchLine(path string, lineNumber int) string {
	return `{"type":"match","data":{"path":{"text":"` + path + `"},"lines":{"text":"foo\n"},"line_number":` + strconv.Itoa(lineNumber) + `,"absolute_offset":0,"submatches":[{"match":{"text":"foo"},"start":0,"end":3}]}}` + "\n"
}

func fakeFactory(process *fakeSearchProcess) ProcessFactory {
	return func(ProcessSpec) (ManagedProcess, error) {
		return process, nil
	}
}

type fakeSearchProcess struct {
	stdout       io.Reader
	stderr       io.Reader
	exit         ProcessExit
	stdoutClosed <-chan struct{}
	onSignal     func()

	mu                  sync.Mutex
	sigList             []string
	waitBeforeStdoutEOF bool
}

func (p *fakeSearchProcess) Stdout() io.Reader { return p.stdout }
func (p *fakeSearchProcess) Stderr() io.Reader { return p.stderr }

func (p *fakeSearchProcess) Signal(_ os.Signal) error {
	p.mu.Lock()
	p.sigList = append(p.sigList, "terminated")
	p.mu.Unlock()
	if p.onSignal != nil {
		p.onSignal()
	}
	return nil
}

func (p *fakeSearchProcess) Kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sigList = append(p.sigList, "killed")
	return nil
}

func (p *fakeSearchProcess) Wait() ProcessExit {
	if p.stdoutClosed != nil {
		select {
		case <-p.stdoutClosed:
		default:
			p.mu.Lock()
			p.waitBeforeStdoutEOF = true
			p.mu.Unlock()
		}
	}
	return p.exit
}

func (p *fakeSearchProcess) signals() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.sigList...)
}

func (p *fakeSearchProcess) waitedBeforeStdoutEOF() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitBeforeStdoutEOF
}

type eofTrackingReader struct {
	reader io.Reader
	eof    chan struct{}
	once   sync.Once
}

func newEOFTrackingReader(reader io.Reader) *eofTrackingReader {
	return &eofTrackingReader{reader: reader, eof: make(chan struct{})}
}

func (r *eofTrackingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if err == io.EOF {
		r.once.Do(func() {
			close(r.eof)
		})
	}
	return n, err
}

func fixedTime() time.Time {
	return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC)
}

func collectSearchMessages(t *testing.T, emitted <-chan any, timeout time.Duration, done func([]any) bool) []any {
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

func countSearchMessages[T any](messages []any) int {
	count := 0
	for _, message := range messages {
		if _, ok := message.(T); ok {
			count++
		}
	}
	return count
}

func filterSearchMessages[T any](messages []any) []T {
	filtered := []T{}
	for _, message := range messages {
		if typed, ok := message.(T); ok {
			filtered = append(filtered, typed)
		}
	}
	return filtered
}

func intPtr(value int) *int          { return &value }
func stringPtr(value string) *string { return &value }
