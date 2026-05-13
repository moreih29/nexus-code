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
)

const streamChunkBytes = 64 * 1024

type StreamParams struct {
	StreamID     string            `json:"streamId"`
	Args         []string          `json:"args"`
	Cwd          string            `json:"cwd,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	Interactive  bool              `json:"interactive,omitempty"`
	StreamStderr bool              `json:"streamStderr,omitempty"`
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
	if params.StreamStderr {
		return s.streamCommandStderr(streamCtx, cancel, cmd, params)
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
	return buildRunResult("", stderr.String(), code, params.Args), nil
}

func (s *Service) streamCommandStderr(streamCtx context.Context, cancel context.CancelFunc, cmd *exec.Cmd, params StreamParams) (any, error) {
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = io.MultiWriter(&stderr, streamChunkWriter{
		ctx:      streamCtx,
		service:  s,
		streamID: params.StreamID,
	})
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, mapGitStartError(err, params.Args)
	}
	waitErr := cmd.Wait()
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		return nil, fatal
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
