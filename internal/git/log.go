package git

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// LogBatchSize mirrors LOG_CHUNK_ENTRY_COUNT in src/shared/types/git.ts.
const LogBatchSize = 50

const (
	logFieldSeparator  = "\x1f"
	logRecordSeparator = "\x1e"
	logFieldCount      = 9
)

var logPrettyFields = []string{"%H", "%h", "%P", "%an", "%ae", "%aI", "%s", "%b", "%D"}

type LogParams struct {
	Scope    string   `json:"scope,omitempty"`
	Cwd      string   `json:"cwd,omitempty"`
	Ref      string   `json:"ref,omitempty"`
	Grep     string   `json:"grep,omitempty"`
	Skip     *int     `json:"skip,omitempty"`
	Limit    int      `json:"limit,omitempty"`
	AfterSHA string   `json:"afterSha,omitempty"`
	Paths    []string `json:"paths,omitempty"`
	Source   *bool    `json:"source,omitempty"`
	StreamID string   `json:"streamId,omitempty"`
}

type LogEntryRef struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	IsHead bool   `json:"isHead"`
}

type LogEntry struct {
	SHA         string        `json:"sha"`
	ShortSHA    string        `json:"shortSha,omitempty"`
	Parents     []string      `json:"parents"`
	AuthorName  string        `json:"authorName"`
	AuthorEmail string        `json:"authorEmail,omitempty"`
	AuthoredAt  string        `json:"authoredAt"`
	Subject     string        `json:"subject"`
	Body        string        `json:"body,omitempty"`
	Refs        []LogEntryRef `json:"refs"`
}

type LogBatchPayload struct {
	StreamID string     `json:"streamId,omitempty"`
	Entries  []LogEntry `json:"entries"`
}

type LogResult struct {
	Count        int  `json:"count"`
	HasMore      bool `json:"hasMore"`
	TotalScanned *int `json:"totalScanned,omitempty"`
}

// Log streams parsed git log entries as git.log.batch events and returns the
// final count / pagination state once traversal has stopped.
func (s *Service) Log(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseLogParams(raw)
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

	args := buildLogArgs(params)
	cmd, err := s.command(streamCtx, args, params.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Kill()
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

	killedForLimit := false
	result, readErr := s.consumeLogOutput(streamCtx, stdout, params, func() error {
		killedForLimit = true
		return cmd.Cancel()
	})
	waitErr := cmd.Wait()

	if readErr != nil && !(killedForLimit && isClosedPipeReadError(readErr)) {
		return nil, readErr
	}
	if ctxErr := streamCtx.Err(); ctxErr != nil && !killedForLimit {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 && !killedForLimit {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = "git.log failed"
		}
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: message}
	}
	return result, nil
}

func parseLogParams(raw json.RawMessage) (LogParams, error) {
	var params LogParams
	if len(raw) == 0 {
		params.Scope = "ref"
		return params, nil
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return params, proto.ProtocolError("git.log params must be an object")
	}
	if strings.Contains(params.Cwd, "\x00") {
		return params, proto.ProtocolError("git.log cwd must not contain NUL")
	}
	if strings.Contains(params.StreamID, "\x00") {
		return params, proto.ProtocolError("git.log streamId must not contain NUL")
	}
	params.Scope = strings.TrimSpace(params.Scope)
	if params.Scope == "" {
		params.Scope = "ref"
	}
	if params.Scope != "ref" && params.Scope != "all" && params.Scope != "branches" {
		return params, proto.ProtocolError("git.log scope must be ref, all, or branches")
	}
	params.Ref = strings.TrimSpace(params.Ref)
	params.Grep = strings.TrimSpace(params.Grep)
	params.AfterSHA = strings.TrimSpace(params.AfterSHA)
	params.StreamID = strings.TrimSpace(params.StreamID)
	if params.Limit < 0 {
		return params, proto.ProtocolError("git.log limit must be non-negative")
	}
	if params.Skip != nil {
		if *params.Skip < 0 {
			return params, proto.ProtocolError("git.log skip must be non-negative")
		}
		if params.Scope != "ref" {
			return params, proto.ProtocolError("git.log skip is only supported for ref scope")
		}
	}
	if containsNUL(params.Ref, params.Grep, params.AfterSHA, params.StreamID) {
		return params, proto.ProtocolError("git.log params must not contain NUL")
	}
	for _, path := range params.Paths {
		if !validLogPath(path) {
			return params, proto.ProtocolError("git.log paths must stay inside the repository")
		}
	}
	return params, nil
}

func buildLogArgs(params LogParams) []string {
	scope := params.Scope
	if scope == "" {
		scope = "ref"
	}
	hasSource := logHasSource(params)
	formatFields := logPrettyFields
	if hasSource {
		formatFields = append([]string{"%S"}, logPrettyFields...)
	}
	args := []string{"log", "--pretty=format:" + strings.Join(formatFields, "%x1f") + "%x1e", "--date=iso-strict"}
	if params.Grep != "" {
		args = append(args, "--grep="+params.Grep)
	}
	if scope == "ref" && params.Skip != nil && *params.Skip > 0 {
		args = append(args, "--skip="+itoa(*params.Skip))
	}
	usesStreamCursorSeek := scope != "ref" && params.AfterSHA != ""
	if params.Limit > 0 && !usesStreamCursorSeek {
		args = append(args, "--max-count="+itoa(params.Limit+1))
	}
	if hasSource {
		args = append(args, "--source")
	}
	if scope == "all" {
		args = append(args, "--all")
	}
	if scope == "branches" {
		args = append(args, "--branches")
	}
	if scope == "ref" && params.AfterSHA != "" {
		args = append(args, params.AfterSHA+"^@")
	} else if scope == "ref" && params.Ref != "" {
		args = append(args, params.Ref)
	}
	if len(params.Paths) > 0 {
		args = append(args, "--")
		args = append(args, params.Paths...)
	}
	return args
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[i:])
}

func logHasSource(params LogParams) bool {
	if params.Source != nil {
		return *params.Source
	}
	return params.Scope == "all" || params.Scope == "branches"
}

func (s *Service) consumeLogOutput(ctx context.Context, reader io.Reader, params LogParams, killForLimit func() error) (LogResult, error) {
	hasSource := logHasSource(params)
	cursorSHA := ""
	if params.Scope != "ref" {
		cursorSHA = params.AfterSHA
	}
	cursorReached := cursorSHA == ""
	count := 0
	totalScanned := 0
	recordCursor := false
	if params.Limit > 0 || cursorSHA != "" {
		recordCursor = true
	}
	hasMore := false
	batch := make([]LogEntry, 0, LogBatchSize)

	emitBatch := func() error {
		if len(batch) == 0 {
			return nil
		}
		entries := append([]LogEntry(nil), batch...)
		batch = batch[:0]
		return s.emitLogBatch(params.StreamID, entries)
	}

	scanner := bufio.NewReader(reader)
	for {
		if err := ctx.Err(); err != nil {
			return LogResult{}, err
		}
		record, err := scanner.ReadString(logRecordSeparator[0])
		if len(record) > 0 {
			record = strings.TrimSuffix(record, logRecordSeparator)
			entry, ok := ParseLogRecord(record, hasSource)
			if ok {
				totalScanned++
				if !cursorReached {
					cursorReached = entry.SHA == cursorSHA
				} else if params.Limit > 0 && count >= params.Limit {
					hasMore = true
					if killForLimit != nil {
						_ = killForLimit()
					}
					break
				} else {
					batch = append(batch, entry)
					count++
					if len(batch) >= LogBatchSize {
						if err := emitBatch(); err != nil {
							return LogResult{}, err
						}
					}
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return LogResult{}, ctxErr
			}
			return LogResult{}, err
		}
	}
	if err := emitBatch(); err != nil {
		return LogResult{}, err
	}
	result := LogResult{Count: count, HasMore: hasMore}
	if recordCursor {
		result.TotalScanned = &totalScanned
	}
	return result, nil
}

func (s *Service) emitLogBatch(streamID string, entries []LogEntry) error {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink("git.log.batch", LogBatchPayload{StreamID: streamID, Entries: entries})
}

// ParseLogRecord converts one custom-formatted git log record into a LogEntry.
func ParseLogRecord(record string, hasSource bool) (LogEntry, bool) {
	normalized := strings.TrimPrefix(record, "\n")
	if strings.TrimSpace(normalized) == "" {
		return LogEntry{}, false
	}
	fields := strings.Split(normalized, logFieldSeparator)
	offset := 0
	if hasSource {
		offset = 1
	}
	if len(fields) < offset+logFieldCount {
		return LogEntry{}, false
	}
	sha := fields[offset]
	if sha == "" {
		return LogEntry{}, false
	}
	parents := []string{}
	if rawParents := fields[offset+2]; rawParents != "" {
		parents = strings.Fields(rawParents)
	}
	body := strings.TrimSpace(strings.Join(fields[offset+7:len(fields)-1], logFieldSeparator))
	entry := LogEntry{
		SHA:         sha,
		ShortSHA:    emptyToOmitted(fields[offset+1]),
		Parents:     parents,
		AuthorName:  fields[offset+3],
		AuthorEmail: emptyToOmitted(fields[offset+4]),
		AuthoredAt:  fields[offset+5],
		Subject:     fields[offset+6],
		Body:        emptyToOmitted(body),
		Refs:        parseLogDecorations(fields[len(fields)-1]),
	}
	return entry, true
}

func emptyToOmitted(value string) string {
	if value == "" {
		return ""
	}
	return value
}

func parseLogDecorations(decorations string) []LogEntryRef {
	refs := []LogEntryRef{}
	indexes := map[string]int{}
	pushRef := func(ref LogEntryRef, ok bool) {
		if !ok {
			return
		}
		key := ref.Kind + ":" + ref.Name
		if idx, exists := indexes[key]; exists {
			refs[idx].IsHead = refs[idx].IsHead || ref.IsHead
			return
		}
		indexes[key] = len(refs)
		refs = append(refs, ref)
	}

	for _, rawPart := range strings.Split(decorations, ",") {
		part := strings.TrimSpace(rawPart)
		if part == "" {
			continue
		}
		if arrowIndex := strings.Index(part, " -> "); arrowIndex >= 0 {
			sourceRef, sourceOK := parseDecorationRef(strings.TrimSpace(part[:arrowIndex]), false)
			pushRef(sourceRef, sourceOK)
			targetRef, targetOK := parseDecorationRef(strings.TrimSpace(part[arrowIndex+4:]), sourceOK && sourceRef.Kind == "head")
			pushRef(targetRef, targetOK)
			continue
		}
		ref, ok := parseDecorationRef(part, false)
		pushRef(ref, ok)
	}
	return refs
}

func parseDecorationRef(rawName string, isHeadTarget bool) (LogEntryRef, bool) {
	if rawName == "" {
		return LogEntryRef{}, false
	}
	if rawName == "HEAD" {
		return LogEntryRef{Name: "HEAD", Kind: "head", IsHead: true}, true
	}
	if strings.HasPrefix(rawName, "tag: ") {
		return LogEntryRef{Name: normalizeDecoratedRefName(strings.TrimPrefix(rawName, "tag: "), "tag"), Kind: "tag", IsHead: false}, true
	}
	name := normalizeDecoratedRefName(rawName, "")
	if name == "" {
		return LogEntryRef{}, false
	}
	if name == "HEAD" {
		return LogEntryRef{Name: "HEAD", Kind: "head", IsHead: true}, true
	}
	kind := "branch"
	if isDecoratedRemoteRef(rawName, name) {
		kind = "remote"
	}
	return LogEntryRef{Name: name, Kind: kind, IsHead: isHeadTarget}, true
}

func normalizeDecoratedRefName(name string, kind string) string {
	trimmed := strings.TrimSpace(name)
	if kind == "tag" && strings.HasPrefix(trimmed, "refs/tags/") {
		return strings.TrimPrefix(trimmed, "refs/tags/")
	}
	for _, prefix := range []string{"refs/heads/", "refs/remotes/", "refs/tags/"} {
		if strings.HasPrefix(trimmed, prefix) {
			return strings.TrimPrefix(trimmed, prefix)
		}
	}
	return trimmed
}

func isDecoratedRemoteRef(rawName string, normalizedName string) bool {
	if strings.HasPrefix(rawName, "refs/remotes/") {
		return true
	}
	firstSegment := normalizedName
	if slash := strings.Index(firstSegment, "/"); slash >= 0 {
		firstSegment = firstSegment[:slash]
	}
	return firstSegment == "origin" || firstSegment == "upstream"
}

func containsNUL(values ...string) bool {
	for _, value := range values {
		if strings.Contains(value, "\x00") {
			return true
		}
	}
	return false
}

func validLogPath(path string) bool {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" || strings.Contains(trimmed, "\x00") || strings.HasPrefix(trimmed, "/") || windowsAbs.MatchString(trimmed) {
		return false
	}
	parts := strings.Split(strings.ReplaceAll(trimmed, "\\", "/"), "/")
	return !containsPart(parts, "..")
}

func isClosedPipeReadError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "file already closed") || strings.Contains(message, "closed pipe")
}
