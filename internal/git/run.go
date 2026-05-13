package git

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	defaultStdoutCapBytes = 10 * 1024 * 1024
	streamChunkBytes      = 64 * 1024
)

type RunParams struct {
	Args           []string          `json:"args"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Interactive    bool              `json:"interactive,omitempty"`
	StdoutCapBytes int64             `json:"stdoutCapBytes,omitempty"`
}

type RunResult struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Code   int    `json:"code"`
}

type StreamParams struct {
	StreamID    string            `json:"streamId"`
	Args        []string          `json:"args"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Interactive bool              `json:"interactive,omitempty"`
}

type StreamChunkPayload struct {
	StreamID string `json:"streamId"`
	Chunk    string `json:"chunk"`
}

type CancelParams struct {
	StreamID string `json:"streamId"`
}

// Run executes one git command and returns stdout/stderr plus Git's exit code.
// Non-zero Git exits are data, not transport failures; Electron classifies
// them into GitError kinds using its existing stderr catalog.
func (s *Service) Run(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseRunParams(raw)
	if err != nil {
		return nil, err
	}
	cmd, err := s.command(ctx, params.Args, params.Cwd, params.Env, params.Interactive)
	if err != nil {
		return nil, err
	}

	stdoutCap := params.StdoutCapBytes
	if stdoutCap <= 0 {
		stdoutCap = defaultStdoutCapBytes
	}
	var stdout cappedBuffer
	stdout.cap = stdoutCap
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if stdout.overflow {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("git stdout exceeded %d bytes", stdoutCap)}
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	return RunResult{Stdout: stdout.String(), Stderr: stderr.String(), Code: code}, nil
}

// Stream executes one git command and emits stdout chunks as git.streamChunk
// events. The final response carries stderr and the exit code.
func (s *Service) Stream(ctx context.Context, raw json.RawMessage) (any, error) {
	var params StreamParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, proto.ProtocolError("git.stream params must include streamId and args")
	}
	if strings.TrimSpace(params.StreamID) == "" {
		return nil, proto.ProtocolError("git.stream streamId is required")
	}
	if err := validateGitArgs(params.Args); err != nil {
		return nil, err
	}

	streamCtx, cancel := context.WithCancel(ctx)
	if err := s.registerStream(params.StreamID, cancel); err != nil {
		cancel()
		return nil, err
	}
	defer s.unregisterStream(params.StreamID)

	cmd, err := s.command(streamCtx, params.Args, params.Cwd, params.Env, params.Interactive)
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, mapGitStartError(err, params.Args)
	}

	readErr := s.emitStreamChunks(streamCtx, params.StreamID, stdout)
	waitErr := cmd.Wait()
	if readErr != nil && !errors.Is(readErr, context.Canceled) {
		cancel()
		return nil, readErr
	}
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		return nil, fatal
	}
	return RunResult{Stdout: "", Stderr: stderr.String(), Code: code}, nil
}

// Cancel stops an in-flight git.stream request.
func (s *Service) Cancel(ctx context.Context, raw json.RawMessage) (any, error) {
	var params CancelParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, proto.ProtocolError("git.cancel params must include streamId")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	cancel := s.streams[params.StreamID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return struct{}{}, nil
}

func parseRunParams(raw json.RawMessage) (RunParams, error) {
	var params RunParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return params, proto.ProtocolError("git.run params must include args")
	}
	if err := validateGitArgs(params.Args); err != nil {
		return params, err
	}
	return params, nil
}

func validateGitArgs(args []string) error {
	if len(args) == 0 {
		return proto.ProtocolError("git args are required")
	}
	for _, arg := range args {
		if strings.Contains(arg, "\x00") {
			return proto.ProtocolError("git args must not contain NUL")
		}
	}
	return nil
}

func (s *Service) command(ctx context.Context, args []string, cwd string, env map[string]string, interactive bool) (*exec.Cmd, error) {
	if err := validateGitArgs(args); err != nil {
		return nil, err
	}
	resolvedCwd, err := s.resolveCwd(ctx, cwd)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = resolvedCwd
	cmd.Env = gitEnv(env, interactive)
	return cmd, nil
}

func (s *Service) resolveCwd(ctx context.Context, cwd string) (string, error) {
	if strings.Contains(cwd, "\x00") {
		return "", proto.ProtocolError("git cwd must not contain NUL")
	}
	if strings.TrimSpace(cwd) == "" {
		return s.root, nil
	}

	var clean string
	if filepath.IsAbs(cwd) {
		clean = filepath.Clean(cwd)
	} else {
		clean = filepath.Clean(filepath.Join(s.root, cwd))
	}
	if isInside(clean, s.root) {
		return clean, nil
	}

	topLevel, err := gitTopLevel(ctx, s.root)
	if err == nil && samePath(clean, topLevel) {
		return clean, nil
	}
	return "", proto.ProtocolError("git cwd must stay inside the workspace or its detected repository root")
}

func gitTopLevel(ctx context.Context, root string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	cmd.Dir = root
	cmd.Env = gitEnv(nil, false)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return filepath.Clean(strings.TrimSpace(string(out))), nil
}

func isInside(candidate string, root string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func samePath(a string, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

func gitEnv(overrides map[string]string, interactive bool) []string {
	env := os.Environ()
	env = appendOrReplaceEnv(env, "GIT_TERMINAL_PROMPT", "0")
	env = appendOrReplaceEnv(env, "GIT_FLUSH", "1")
	if !interactive {
		env = appendOrReplaceEnv(env, "GIT_ASKPASS", "echo")
		env = appendOrReplaceEnv(env, "SSH_ASKPASS_REQUIRE", "force")
		env = appendOrReplaceEnv(env, "SSH_ASKPASS", "echo")
	}
	for key, value := range overrides {
		if strings.Contains(key, "\x00") || strings.Contains(value, "\x00") || strings.Contains(key, "=") || key == "" {
			continue
		}
		env = appendOrReplaceEnv(env, key, value)
	}
	return env
}

func appendOrReplaceEnv(env []string, key string, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func gitExitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 0, mapGitStartError(err, nil)
}

func mapGitStartError(err error, args []string) error {
	if errors.Is(err, exec.ErrNotFound) {
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git executable not found"}
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
}

func (s *Service) registerStream(streamID string, cancel context.CancelFunc) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.streams[streamID]; exists {
		return proto.ProtocolError("git.stream streamId is already active")
	}
	s.streams[streamID] = cancel
	return nil
}

func (s *Service) unregisterStream(streamID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.streams, streamID)
}

func (s *Service) emitStreamChunks(ctx context.Context, streamID string, stdout io.Reader) error {
	buf := make([]byte, streamChunkBytes)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			payload := StreamChunkPayload{
				StreamID: streamID,
				Chunk:    base64.StdEncoding.EncodeToString(buf[:n]),
			}
			s.mu.Lock()
			sink := s.sink
			s.mu.Unlock()
			if sink != nil {
				if emitErr := sink("git.streamChunk", payload); emitErr != nil {
					return emitErr
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
	}
}

type cappedBuffer struct {
	bytes.Buffer
	cap      int64
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.cap <= 0 {
		return b.Buffer.Write(p)
	}
	remaining := b.cap - int64(b.Buffer.Len())
	if remaining <= 0 {
		b.overflow = true
		return len(p), nil
	}
	if int64(len(p)) > remaining {
		b.overflow = true
		_, _ = b.Buffer.Write(p[:remaining])
		return len(p), nil
	}
	return b.Buffer.Write(p)
}
