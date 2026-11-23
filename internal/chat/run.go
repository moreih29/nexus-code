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

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	RunCapability   = "chat.run"
	runTimeout      = 15 * time.Minute
	runOutputCap    = 4 * 1024 * 1024
	runCloseGrace   = 2500 * time.Millisecond
	earlyCancelTTL  = 30 * time.Second
	maxEarlyCancels = 256
)

type runID struct {
	RunID string `json:"runId"`
}

type runKey struct {
	connection <-chan struct{}
	id         string
}

type activeRun struct {
	cancel context.CancelFunc
	done   chan struct{}
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

func (s *Service) Run(ctx context.Context, raw json.RawMessage) (any, error) {
	var p runParams
	if err := proto.DecodeParams(raw, &p, "chat.run params must include runId, cwd and program"); err != nil {
		return nil, err
	}
	if !validRunID(p.RunID) || !filepath.IsAbs(p.Program) || !filepath.IsAbs(p.Cwd) {
		return nil, proto.ProtocolError("chat.run requires a runId and absolute program and cwd")
	}
	timeout := runTimeout
	if p.TimeoutMs > 0 && p.TimeoutMs < int(runTimeout/time.Millisecond) {
		timeout = time.Duration(p.TimeoutMs) * time.Millisecond
	}
	deadline, stop := context.WithTimeout(ctx, timeout)
	defer stop()
	runCtx, cancel := context.WithCancelCause(deadline)
	defer cancel(nil)

	key := runKey{connection: ctx.Done(), id: p.RunID}
	s.mu.Lock()
	if s.closed || s.runs[key] != nil {
		s.mu.Unlock()
		return nil, proto.ProtocolError("chat.run ID is already running or the service is closed")
	}
	if expires, ok := s.earlyRunCancels[key]; ok {
		delete(s.earlyRunCancels, key)
		if time.Now().Before(expires) {
			s.mu.Unlock()
			return runResult{ExecResult: ExecResult{Code: -1}, Canceled: true}, nil
		}
	}
	if s.runs == nil {
		s.runs = make(map[runKey]*activeRun)
	}
	active := &activeRun{cancel: func() { cancel(nil) }, done: make(chan struct{})}
	s.runs[key] = active
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.runs, key)
		close(active.done)
		s.mu.Unlock()
	}()

	cmd := exec.CommandContext(runCtx, p.Program, p.Args...)
	cmd.Dir = p.Cwd
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
		case err == nil, errors.Is(err, exec.ErrWaitDelay):
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

func (s *Service) CancelRun(ctx context.Context, raw json.RawMessage) (any, error) {
	var p runID
	if err := proto.DecodeParams(raw, &p, "chat.cancelRun params must include runId"); err != nil {
		return nil, err
	}
	if !validRunID(p.RunID) {
		return nil, proto.ProtocolError("chat.cancelRun runId is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := runKey{connection: ctx.Done(), id: p.RunID}
	if active := s.runs[key]; active != nil {
		active.cancel()
		return true, nil
	}
	if !s.closed && ctx.Err() == nil {
		s.rememberRunCancel(key, time.Now())
	}
	return false, nil
}

func (s *Service) rememberRunCancel(key runKey, now time.Time) {
	if s.earlyRunCancels == nil {
		s.earlyRunCancels = make(map[runKey]time.Time)
	}
	for candidate, expires := range s.earlyRunCancels {
		if !now.Before(expires) {
			delete(s.earlyRunCancels, candidate)
		}
	}
	if len(s.earlyRunCancels) < maxEarlyCancels {
		s.earlyRunCancels[key] = now.Add(earlyCancelTTL)
	}
}

func validRunID(id string) bool {
	return strings.TrimSpace(id) != "" && len(id) <= 128
}

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
