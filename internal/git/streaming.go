package git

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
	"github.com/nexus-code/nexus-code/internal/redact"
)

const streamChunkBytes = 64 * 1024

type StreamParams struct {
	StreamID       string            `json:"streamId"`
	Args           []string          `json:"args"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Interactive    bool              `json:"interactive,omitempty"`
	StreamStderr   bool              `json:"streamStderr,omitempty"`
	StdoutCapBytes int64             `json:"stdoutCapBytes,omitempty"`
}

type StreamChunkPayload struct {
	StreamID string `json:"streamId"`
	Chunk    string `json:"chunk"`
}

type CancelParams struct {
	StreamID string `json:"streamId"`
}

// Stream executes one git command and emits stdout chunks as git.streamChunk
// events. When streamStderr is true, stderr is emitted instead while still
// being buffered for final classification. The final response carries stderr
// and the exit code.
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

	// The stream id doubles as the run id, so git.cancel and askpass routing
	// work as for git.run.
	streamCtx, cancel, err := s.startRun(ctx, params.StreamID)
	if err != nil {
		return nil, err
	}
	defer cancel()

	cmd, err := s.command(streamCtx, params.Args, params.Cwd, params.Env, params.Interactive)
	if err != nil {
		cancel()
		return nil, err
	}
	if params.StreamStderr {
		return s.streamCommandStderr(streamCtx, cancel, cmd, params)
	}
	var stderr gitStderr
	cmd.Stderr = &stderr
	stdout, finish, err := startGitOutput(streamCtx, cmd)
	if err != nil {
		cancel()
		return nil, mapGitStartError(err, params.Args)
	}

	limit := stdoutBudget(params.StdoutCapBytes)
	readErr := s.emitStreamChunks(streamCtx, params.StreamID, stdout, limit)
	if readErr != nil {
		// Nobody reads stdout any more (the event sink failed or the stream
		// was cancelled): kill git first, or it blocks on a full pipe and
		// Wait never returns.
		cancel()
	}
	waitErr := finish()
	if errors.Is(readErr, errGitOutputLimit) {
		return outputLimitResult(stderr.String(), limit), nil
	}
	if readErr != nil && !errors.Is(readErr, context.Canceled) {
		return nil, readErr
	}
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, waitErr)
	if fatal != nil {
		return nil, fatal
	}
	return buildRunResult("", stderr.String(), code, params.Args), nil
}

func (s *Service) streamCommandStderr(streamCtx context.Context, cancel context.CancelFunc, cmd *exec.Cmd, params StreamParams) (any, error) {
	var stderr gitStderr
	cmd.Stdout = io.Discard
	diagnostics := &stderrStream{output: streamChunkWriter{
		ctx:      streamCtx,
		service:  s,
		streamID: params.StreamID,
	}}
	cmd.Stderr = io.MultiWriter(&stderr, diagnostics)
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, mapGitStartError(err, params.Args)
	}
	waitErr := cmd.Wait()
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, waitErr)
	if fatal != nil {
		return nil, fatal
	}
	if err := diagnostics.flush(); err != nil {
		return nil, err
	}
	return buildRunResult("", stderr.String(), code, params.Args), nil
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

func (s *Service) emitStreamChunks(ctx context.Context, streamID string, stdout io.Reader, remaining int64) error {
	buf := make([]byte, streamChunkBytes)
	for {
		n, err := stdout.Read(buf)
		if int64(n) > remaining {
			return errGitOutputLimit
		}
		if n > 0 {
			remaining -= int64(n)
			if err := s.emitStreamChunk(streamID, buf[:n]); err != nil {
				return err
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

// stderrStream masks complete diagnostic lines so a secret split across
// reads never reaches a stream event. Git progress also delimits with CR.
type stderrStream struct {
	output    streamChunkWriter
	pending   []byte
	oversized bool
}

func (s *stderrStream) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		end := bytes.IndexAny(p, "\r\n")
		line := p
		if end >= 0 {
			line = p[:end+1]
		}
		if !s.oversized {
			if len(s.pending)+len(line) > captureTailBytes {
				s.pending = s.pending[:0]
				s.oversized = true
			} else {
				s.pending = append(s.pending, line...)
			}
		}
		if end >= 0 {
			if err := s.flush(); err != nil {
				return written, err
			}
		}
		written += len(line)
		p = p[len(line):]
	}
	return written, nil
}

// flush emits one masked line or an explicit diagnostic for an oversized line.
func (s *stderrStream) flush() error {
	line := redact.Credentials(string(s.pending))
	if s.oversized {
		line = "[Git stderr line exceeded the 1 MiB limit]\n"
	}
	s.pending = s.pending[:0]
	s.oversized = false
	_, err := s.output.Write([]byte(line))
	return err
}

type streamChunkWriter struct {
	ctx      context.Context
	service  *Service
	streamID string
}

func (w streamChunkWriter) Write(chunk []byte) (int, error) {
	written := 0
	for len(chunk) > 0 {
		if err := w.ctx.Err(); err != nil {
			return written, err
		}
		take := len(chunk)
		if take > streamChunkBytes {
			take = streamChunkBytes
		}
		if err := w.service.emitStreamChunk(w.streamID, chunk[:take]); err != nil {
			return written, err
		}
		written += take
		chunk = chunk[take:]
	}
	return written, nil
}

func (s *Service) emitStreamChunk(streamID string, chunk []byte) error {
	payload := StreamChunkPayload{
		StreamID: streamID,
		Chunk:    base64.StdEncoding.EncodeToString(chunk),
	}
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink("git.streamChunk", payload)
}
