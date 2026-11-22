package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	RunCapability = "chat.run"
	runTimeout    = 15 * time.Minute
	runOutputCap  = 4 * 1024 * 1024
)

type runID struct {
	RunID string `json:"runId"`
}

type runParams struct {
	ExecParams
	runID
	Stdin string `json:"stdin"`
}

type runResult struct {
	ExecResult
	Canceled    bool `json:"canceled,omitempty"`
	OutputLimit bool `json:"outputLimit,omitempty"`
}

var errRunOutputLimit = errors.New("chat.run exceeded its output limit")

// Run runs an owned one-shot process with stdin and an explicit environment.
func (s *Service) Run(ctx context.Context, raw json.RawMessage) (any, error) {
	var p runParams
	if err := decodeParams(raw, &p, "chat.run params must include runId, cwd and program"); err != nil {
		return nil, err
	}
	if !validRunID(p.RunID) || !filepath.IsAbs(p.Program) || !filepath.IsAbs(p.Cwd) {
		return nil, protocolError("chat.run requires a runId and absolute program and cwd")
	}
	timeout := runTimeout
	if p.TimeoutMs > 0 && p.TimeoutMs < int(runTimeout/time.Millisecond) {
		timeout = time.Duration(p.TimeoutMs) * time.Millisecond
	}
	deadline, stop := context.WithTimeout(ctx, timeout)
	defer stop()
	runCtx, cancel := context.WithCancelCause(deadline)
	defer cancel(nil)

	s.mu.Lock()
	if s.closed || s.runs[p.RunID] != nil {
		s.mu.Unlock()
		return nil, protocolError("chat.run ID is already running or the service is closed")
	}
	if s.runs == nil {
		s.runs = make(map[string]context.CancelFunc)
	}
	s.runs[p.RunID] = func() { cancel(nil) }
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.runs, p.RunID)
		s.mu.Unlock()
	}()

	cmd := exec.CommandContext(runCtx, p.Program, p.Args...)
	cmd.Dir = p.Cwd
	// An empty but non-nil Env prevents os/exec from inheriting the agent's env.
	cmd.Env = make([]string, 0, len(p.Env))
	for key, value := range p.Env {
		if !strings.HasPrefix(strings.ToUpper(key), "NEXUS_") {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	sort.Strings(cmd.Env)
	cmd.Stdin = strings.NewReader(p.Stdin)
	cmd.WaitDelay = time.Second
	output := runOutput{remaining: runOutputCap, cancel: cancel}
	stdout, stderr := runStream{output: &output}, runStream{output: &output}
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := runOwnedCommand(cmd)

	result := runResult{ExecResult: ExecResult{
		Stdout: decodeOutput(stdout.buf.Bytes()), Stderr: decodeOutput(stderr.buf.Bytes()),
	}}
	var exitErr *exec.ExitError
	switch context.Cause(runCtx) {
	case context.DeadlineExceeded:
		result.TimedOut, result.Code = true, -1
	case context.Canceled:
		result.Canceled, result.Code = true, -1
	case errRunOutputLimit:
		result.OutputLimit, result.Code = true, -1
	default:
		switch {
		case err == nil:
		case errors.As(err, &exitErr):
			result.Code = exitErr.ExitCode()
		default:
			result.Code = -1
			if result.Stderr == "" {
				result.Stderr = err.Error()
			}
		}
	}
	return result, nil
}

// CancelRun acknowledges whether this ID was still registered.
func (s *Service) CancelRun(_ context.Context, raw json.RawMessage) (any, error) {
	var p runID
	if err := decodeParams(raw, &p, "chat.cancelRun params must include runId"); err != nil {
		return nil, err
	}
	if !validRunID(p.RunID) {
		return nil, protocolError("chat.cancelRun runId is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel := s.runs[p.RunID]
	if cancel != nil {
		cancel()
	}
	return cancel != nil, nil
}

func validRunID(id string) bool {
	return strings.TrimSpace(id) != "" && len(id) <= 128
}

// Both output pipes share one byte budget. Crossing it ends the process.
type runOutput struct {
	mu        sync.Mutex
	remaining int
	cancel    context.CancelCauseFunc
}

type runStream struct {
	buf    bytes.Buffer
	output *runOutput
}

func (s *runStream) Write(p []byte) (int, error) {
	s.output.mu.Lock()
	defer s.output.mu.Unlock()
	n := min(len(p), s.output.remaining)
	s.buf.Write(p[:n])
	s.output.remaining -= n
	if n < len(p) {
		s.output.cancel(errRunOutputLimit)
	}
	return len(p), nil
}
