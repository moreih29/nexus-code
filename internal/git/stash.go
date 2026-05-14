package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// stashRefRE matches the canonical stash@{n} reference format.
var stashRefRE = regexp.MustCompile(`^stash@\{(\d+)\}$`)

// stashMessagePatterns mirror the TS STASH_MESSAGE_PATTERNS.
var stashMessagePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^On ([^:]+):\s*(.*)`),
	regexp.MustCompile(`(?i)^WIP on ([^:]+):\s*(.*)`),
}

// stashListFormat is the NUL-delimited format consumed by parseStashList.
const stashListFormat = "--format=%gd%x00%H%x00%gs%x00%ct%x00"

// StashListParams carries optional cwd for stash list.
type StashListParams struct {
	Cwd string `json:"cwd,omitempty"`
}

// StashEntry mirrors src/shared/types/git.ts StashEntrySchema.
type StashEntry struct {
	Index     int    `json:"index"`
	SHA       string `json:"sha"`
	Message   string `json:"message"`
	Branch    string `json:"branch,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// StashIndexParams carries a stash index and optional cwd.
type StashIndexParams struct {
	Cwd   string `json:"cwd,omitempty"`
	Index int    `json:"index"`
}

// StashPopParams carries optional cwd for parameterless stash pop.
type StashPopParams struct {
	Cwd string `json:"cwd,omitempty"`
}

// StashApplyResult mirrors the run-result shape for apply/pop so the TS
// executor can inspect errorKind without parsing a thrown error message.
type StashApplyResult struct {
	ErrorKind    Kind   `json:"errorKind,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// StashShowParams carries the stash index and streaming identifiers.
type StashShowParams struct {
	Cwd           string `json:"cwd,omitempty"`
	StreamID      string `json:"streamId,omitempty"`
	Index         int    `json:"index"`
	MaxChunkBytes int    `json:"maxChunkBytes,omitempty"`
}

// StashGroupParams carries the paths and optional message for a grouped stash.
type StashGroupParams struct {
	Cwd     string   `json:"cwd,omitempty"`
	Message string   `json:"message,omitempty"`
	Paths   []string `json:"paths"`
}

// StashShowResult mirrors DiffResult and is returned after all chunks are sent.
type StashShowResult struct {
	Bytes     int64 `json:"bytes"`
	Truncated bool  `json:"truncated"`
}

// StashList executes `git stash list` and returns parsed StashEntry records.
func (s *Service) StashList(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StashListParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, proto.ProtocolError("git.stash.list params must be an object")
		}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.list cwd must not contain NUL")
	}

	args := []string{"stash", "list", stashListFormat}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	entries := parseStashList(stdout.String())
	return entries, nil
}

// StashApply applies a stash entry by index. Conflicts are returned in the
// result struct so the TS executor can surface errorKind without string-parsing.
func (s *Service) StashApply(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StashIndexParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.stash.apply params must include index")
	}
	if p.Index < 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("invalid stash index: %d", p.Index)}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.apply cwd must not contain NUL")
	}

	ref := stashRef(p.Index)
	args := []string{"stash", "apply", ref}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		return classifyStashApplyError(stdout.String(), stderr.String(), args, code), nil
	}
	return StashApplyResult{}, nil
}

// StashDrop removes one stash entry by index.
func (s *Service) StashDrop(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StashIndexParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.stash.drop params must include index")
	}
	if p.Index < 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("invalid stash index: %d", p.Index)}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.drop cwd must not contain NUL")
	}

	ref := stashRef(p.Index)
	args := []string{"stash", "drop", ref}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// StashPop pops the latest stash entry. Conflicts are returned in the result
// struct using the same shape as StashApply.
func (s *Service) StashPop(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StashPopParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, proto.ProtocolError("git.stash.pop params must be an object")
		}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.pop cwd must not contain NUL")
	}

	args := []string{"stash", "pop"}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		return classifyStashApplyError(stdout.String(), stderr.String(), args, code), nil
	}
	return StashApplyResult{}, nil
}

// StashShow streams the patch for one stash entry as bounded UTF-8 text chunks
// (git.stash.show.chunk events) and returns a StashShowResult.
func (s *Service) StashShow(ctx context.Context, raw json.RawMessage) (any, error) {
	params := StashShowParams{MaxChunkBytes: defaultDiffChunkBytes}
	if len(raw) != 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, proto.ProtocolError("git.stash.show params must be an object")
		}
	}
	if params.Index < 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("invalid stash index: %d", params.Index)}
	}
	if strings.Contains(params.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.show cwd must not contain NUL")
	}
	if strings.Contains(params.StreamID, "\x00") {
		return nil, proto.ProtocolError("git.stash.show streamId must not contain NUL")
	}
	if params.MaxChunkBytes <= 0 {
		return nil, proto.ProtocolError("git.stash.show maxChunkBytes must be positive")
	}

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if params.StreamID != "" {
		if err := s.registerStream(params.StreamID, cancel); err != nil {
			return nil, err
		}
		defer s.unregisterStream(params.StreamID)
	}

	ref := stashRef(params.Index)
	args := []string{"stash", "show", "--patch", "--no-ext-diff", ref}
	cmd, err := s.command(streamCtx, args, params.Cwd, nil, false)
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
		return nil, mapGitStartError(err, args)
	}

	result, readErr := s.emitStashChunks(streamCtx, params.StreamID, stdout, params.MaxChunkBytes)
	waitErr := cmd.Wait()

	if readErr != nil {
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return StashShowResult{Bytes: result.Bytes, Truncated: result.Truncated}, nil
}

// StashGroup stashes only the selected paths with an optional message.
func (s *Service) StashGroup(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StashGroupParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.stash.group params must include paths")
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stash.group cwd must not contain NUL")
	}

	// Deduplicate and validate paths.
	seen := make(map[string]struct{}, len(p.Paths))
	unique := make([]string, 0, len(p.Paths))
	for _, path := range p.Paths {
		trimmed := strings.TrimSpace(path)
		if trimmed == "" || strings.Contains(trimmed, "\x00") {
			continue
		}
		if _, ok := seen[trimmed]; !ok {
			seen[trimmed] = struct{}{}
			unique = append(unique, trimmed)
		}
	}
	if len(unique) == 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "path-not-in-repo: no paths selected"}
	}

	args := []string{"stash", "push", "--include-untracked"}
	if msg := strings.TrimSpace(p.Message); msg != "" {
		args = append(args, "-m", msg)
	}
	args = append(args, "--")
	args = append(args, unique...)

	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// parseStashList parses `git stash list --format=%gd%x00%H%x00%gs%x00%ct%x00` output.
func parseStashList(stdout string) []StashEntry {
	fields := strings.Split(stdout, "\x00")
	entries := make([]StashEntry, 0, len(fields)/4)

	for offset := 0; offset+3 < len(fields); offset += 4 {
		ref := strings.TrimSpace(fields[offset])
		if ref == "" {
			continue
		}
		sha := strings.TrimSpace(fields[offset+1])
		rawMsg := normalizeStashRecordText(fields[offset+2])
		tsStr := strings.TrimSpace(fields[offset+3])

		index := parseStashIndex(ref)
		if index < 0 {
			continue
		}
		if sha == "" {
			continue
		}
		createdAtSeconds, err := strconv.ParseFloat(tsStr, 64)
		if err != nil || createdAtSeconds < 0 {
			continue
		}

		branch, message := parseStashSubject(rawMsg)
		entries = append(entries, StashEntry{
			Index:     index,
			SHA:       sha,
			Message:   message,
			Branch:    branch,
			CreatedAt: int64(createdAtSeconds * 1000),
		})
	}
	return entries
}

// parseStashIndex extracts the numeric part from stash@{n}, returning -1 on failure.
func parseStashIndex(ref string) int {
	m := stashRefRE.FindStringSubmatch(ref)
	if m == nil {
		return -1
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return -1
	}
	return n
}

// normalizeStashRecordText removes the leading newline Git prints between NUL-delimited records.
func normalizeStashRecordText(value string) string {
	value = strings.TrimLeft(value, "\r\n")
	return strings.TrimSpace(value)
}

// parseStashSubject splits a stash reflog subject into branch and display message.
func parseStashSubject(rawMessage string) (branch string, message string) {
	for _, pattern := range stashMessagePatterns {
		m := pattern.FindStringSubmatch(rawMessage)
		if m == nil {
			continue
		}
		b := strings.TrimSpace(m[1])
		msg := strings.TrimSpace(m[2])
		if msg == "" {
			msg = rawMessage
		}
		return b, msg
	}
	return "", rawMessage
}

// stashRef builds the canonical stash@{n} reference string.
func stashRef(index int) string {
	return fmt.Sprintf("stash@{%d}", index)
}

// classifyStashApplyError inspects stdout (where some git versions report
// conflicts) and stderr, mapping conflict kinds to KindStashConflict.
func classifyStashApplyError(stdout string, stderr string, args []string, code int) StashApplyResult {
	kind := Classify(stderr)

	// git stash apply can report CONFLICT lines on stdout (not stderr) on some
	// git versions. Mirror TS isStashConflictOutput logic.
	if kind == KindUnknown || kind == KindConflict || kind == KindUnresolvedConflicts {
		if isStashConflictStdout(stdout) {
			kind = KindStashConflict
		}
	}
	if kind == KindConflict || kind == KindUnresolvedConflicts {
		kind = KindStashConflict
	}

	msg := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
	return StashApplyResult{ErrorKind: kind, ErrorMessage: msg}
}

// isStashConflictStdout detects stash conflict markers reported on stdout.
var stashConflictStdoutRE = regexp.MustCompile(`(?i)CONFLICT \([^)]+\):|Merge conflict in|Unmerged paths:`)

func isStashConflictStdout(stdout string) bool {
	return stashConflictStdoutRE.MatchString(stdout)
}

// emitStashChunks reads stdout and emits git.stash.show.chunk events,
// mirroring emitDiffChunks from diff.go but using the stash-specific event name.
func (s *Service) emitStashChunks(ctx context.Context, streamID string, stdout io.Reader, maxChunkBytes int) (StashShowResult, error) {
	var result StashShowResult
	buf := make([]byte, 32*1024)
	pending := make([]byte, 0, maxChunkBytes)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			result.Bytes += int64(n)
			pending = append(pending, buf[:n]...)
			var emitErr error
			pending, emitErr = s.emitReadyStashChunks(ctx, streamID, pending, maxChunkBytes, false)
			if emitErr != nil {
				return result, emitErr
			}
		}
		if err == io.EOF {
			var emitErr error
			pending, emitErr = s.emitReadyStashChunks(ctx, streamID, pending, maxChunkBytes, true)
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

func (s *Service) emitReadyStashChunks(ctx context.Context, streamID string, pending []byte, maxChunkBytes int, final bool) ([]byte, error) {
	for len(pending) > 0 {
		if !final && len(pending) < maxChunkBytes {
			return pending, nil
		}
		chunkLen := utf8SafeChunkLen(pending, maxChunkBytes, final)
		if chunkLen == 0 {
			return pending, nil
		}
		if err := s.emitStashShowChunk(ctx, streamID, string(pending[:chunkLen])); err != nil {
			return pending, err
		}
		pending = pending[chunkLen:]
	}
	return pending, nil
}

func (s *Service) emitStashShowChunk(ctx context.Context, streamID string, text string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil || text == "" {
		return nil
	}
	return sink("git.stash.show.chunk", DiffChunkPayload{StreamID: streamID, Text: text})
}
