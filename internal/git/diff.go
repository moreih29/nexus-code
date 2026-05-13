package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const defaultDiffChunkBytes = 1024 * 1024

type DiffParams struct {
	StreamID      string   `json:"streamId,omitempty"`
	Cwd           string   `json:"cwd,omitempty"`
	From          string   `json:"from,omitempty"`
	To            string   `json:"to,omitempty"`
	Cached        bool     `json:"cached,omitempty"`
	Paths         []string `json:"paths,omitempty"`
	Context       *int     `json:"context,omitempty"`
	Unified       *int     `json:"unified,omitempty"`
	MaxChunkBytes int      `json:"maxChunkBytes,omitempty"`
	MaxBytes      int64    `json:"maxBytes,omitempty"`
}

type DiffChunkPayload struct {
	StreamID string `json:"streamId,omitempty"`
	Text     string `json:"text"`
}

type DiffResult struct {
	Bytes     int64 `json:"bytes"`
	Truncated bool  `json:"truncated"`
}

// Diff executes git diff and emits raw UTF-8-safe text chunks as git.diff.chunk.
func (s *Service) Diff(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseDiffParams(raw)
	if err != nil {
		return nil, err
	}
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if params.StreamID != "" {
		if err := s.registerStream(params.StreamID, cancel); err != nil {
			return nil, err
		}
		defer s.unregisterStream(params.StreamID)
	}

	cmd, err := s.command(streamCtx, diffArgs(params), params.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, mapGitStartError(err, diffArgs(params))
	}
	result, readErr := s.emitDiffChunks(streamCtx, params.StreamID, stdout, params.MaxChunkBytes, params.MaxBytes)
	waitErr := cmd.Wait()
	if readErr != nil && !errors.Is(readErr, context.Canceled) {
		return nil, readErr
	}
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		return nil, diffGitError(stderr.String(), code)
	}
	return result, nil
}

func parseDiffParams(raw json.RawMessage) (DiffParams, error) {
	params := DiffParams{MaxChunkBytes: defaultDiffChunkBytes}
	if len(raw) != 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return params, proto.ProtocolError("git.diff params must be an object")
		}
	}
	if strings.Contains(params.StreamID, "\x00") {
		return params, proto.ProtocolError("git.diff streamId must not contain NUL")
	}
	if strings.Contains(params.Cwd, "\x00") {
		return params, proto.ProtocolError("git.diff cwd must not contain NUL")
	}
	if params.MaxChunkBytes <= 0 {
		return params, proto.ProtocolError("git.diff maxChunkBytes must be positive")
	}
	if params.MaxBytes < 0 {
		return params, proto.ProtocolError("git.diff maxBytes must be non-negative")
	}
	if err := validateDiffToken("from", params.From); err != nil {
		return params, err
	}
	if err := validateDiffToken("to", params.To); err != nil {
		return params, err
	}
	for _, path := range params.Paths {
		if path == "" || strings.Contains(path, "\x00") {
			return params, proto.ProtocolError("git.diff paths must be non-empty and must not contain NUL")
		}
	}
	for name, value := range map[string]*int{"context": params.Context, "unified": params.Unified} {
		if value != nil && *value < 0 {
			return params, proto.ProtocolError("git.diff " + name + " must be non-negative")
		}
	}
	return params, nil
}

func validateDiffToken(name string, value string) error {
	if strings.Contains(value, "\x00") {
		return proto.ProtocolError("git.diff " + name + " must not contain NUL")
	}
	return nil
}

func diffArgs(params DiffParams) []string {
	args := []string{"diff", "--no-ext-diff"}
	if params.Unified != nil {
		args = append(args, "--unified="+strconv.Itoa(*params.Unified))
	} else if params.Context != nil {
		args = append(args, "--unified="+strconv.Itoa(*params.Context))
	}
	if params.Cached {
		args = append(args, "--cached")
	}
	if params.From != "" {
		args = append(args, params.From)
	}
	if params.To != "" {
		args = append(args, params.To)
	}
	if len(params.Paths) > 0 {
		args = append(args, "--")
		args = append(args, params.Paths...)
	}
	return args
}

func (s *Service) emitDiffChunks(ctx context.Context, streamID string, stdout io.Reader, maxChunkBytes int, maxBytes int64) (DiffResult, error) {
	var result DiffResult
	var captured int64
	buf := make([]byte, 32*1024)
	pending := make([]byte, 0, maxChunkBytes)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			result.Bytes += int64(n)
			if maxBytes <= 0 {
				pending = append(pending, buf[:n]...)
				captured += int64(n)
			} else if captured < maxBytes {
				allowed := minInt64(int64(n), maxBytes-captured)
				pending = append(pending, buf[:int(allowed)]...)
				captured += allowed
			}
			if maxBytes > 0 && result.Bytes > maxBytes {
				result.Truncated = true
			}
			var emitErr error
			pending, emitErr = s.emitReadyDiffChunks(ctx, streamID, pending, maxChunkBytes, false)
			if emitErr != nil {
				return result, emitErr
			}
		}
		if err == io.EOF {
			var emitErr error
			pending, emitErr = s.emitReadyDiffChunks(ctx, streamID, pending, maxChunkBytes, true)
			return result, emitErr
		}
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return result, ctxErr
			}
			return result, err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, ctxErr
		}
	}
}

func (s *Service) emitReadyDiffChunks(ctx context.Context, streamID string, pending []byte, maxChunkBytes int, final bool) ([]byte, error) {
	for len(pending) > 0 {
		if !final && len(pending) < maxChunkBytes {
			return pending, nil
		}
		chunkLen := utf8SafeChunkLen(pending, maxChunkBytes, final)
		if chunkLen == 0 {
			return pending, nil
		}
		if err := s.emitDiffChunk(ctx, streamID, string(pending[:chunkLen])); err != nil {
			return pending, err
		}
		pending = pending[chunkLen:]
	}
	return pending, nil
}

func minInt64(a int64, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func utf8SafeChunkLen(buf []byte, maxChunkBytes int, final bool) int {
	if len(buf) <= maxChunkBytes {
		if final {
			return utf8ValidPrefixLen(buf)
		}
		return 0
	}
	cut := maxChunkBytes
	for cut > 0 && !utf8.RuneStart(buf[cut]) {
		cut--
	}
	if cut > 0 {
		return cut
	}
	_, size := utf8.DecodeRune(buf)
	if size > 0 && size <= len(buf) {
		return size
	}
	if final {
		return len(buf)
	}
	return 0
}

func utf8ValidPrefixLen(buf []byte) int {
	for len(buf) > 0 && !utf8.Valid(buf) {
		buf = buf[:len(buf)-1]
	}
	return len(buf)
}

func (s *Service) emitDiffChunk(ctx context.Context, streamID string, text string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil || text == "" {
		return nil
	}
	return sink("git.diff.chunk", DiffChunkPayload{StreamID: streamID, Text: text})
}

func diffGitError(stderr string, code int) error {
	message := strings.TrimSpace(stderr)
	if message == "" {
		message = fmt.Sprintf("git diff exited with code %d", code)
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: message}
}
