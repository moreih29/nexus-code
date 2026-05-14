package git

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// allowedCloneURLPrefixes mirrors isAllowedGitRemoteUrl from
// src/shared/git-remote-validation.ts. Security depth-in-defense — the
// TS client validates first; Go validates again before spawning a process.
var allowedCloneURLPrefixes = []struct {
	prefix        string
	caseSensitive bool
}{
	{"https://", false},
	{"http://", false},
	{"git://", false},
	{"ssh://", false},
	{"file://", false},
	{"git@", true},
}

// cloneNamePattern matches valid local folder names (no path separators,
// no leading dots, alphanumeric/dot/hyphen/underscore only).
var cloneNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// cloneProgressPatterns mirrors GitCloneProgressParser patterns from
// src/main/git/git-clone-progress.ts.
type cloneProgressPattern struct {
	phase   string
	pattern *regexp.Regexp
}

var cloneProgressPatterns = []cloneProgressPattern{
	{"counting", regexp.MustCompile(`(?i)(?:remote:\s*)?Counting objects:\s*(\d+)%\s*\((\d+)/(\d+)\)`)},
	{"compressing", regexp.MustCompile(`(?i)(?:remote:\s*)?Compressing objects:\s*(\d+)%\s*\((\d+)/(\d+)\)`)},
	{"receiving", regexp.MustCompile(`(?i)Receiving objects:\s*(\d+)%\s*\((\d+)/(\d+)\)`)},
	{"resolving", regexp.MustCompile(`(?i)Resolving deltas:\s*(\d+)%\s*\((\d+)/(\d+)\)`)},
	{"checkout", regexp.MustCompile(`(?i)(?:Updating files|Checking out files):\s*(\d+)%\s*\((\d+)/(\d+)\)`)},
}

// cloneProgressMinIntervalMs is the throttle floor for progress events (50 ms).
const cloneProgressMinIntervalMs = 50

// CloneParams carries the parameters for git.clone.
type CloneParams struct {
	StreamID          string            `json:"streamId"`
	URL               string            `json:"url"`
	ParentDir         string            `json:"parentDir"`
	Name              string            `json:"name,omitempty"`
	Branch            string            `json:"branch,omitempty"`
	RecurseSubmodules bool              `json:"recurseSubmodules,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
}

// CloneResult is returned by git.clone on success.
type CloneResult struct {
	AbsPath string `json:"absPath"`
}

// CloneProgressPayload is emitted as git.clone.progress during the operation.
type CloneProgressPayload struct {
	StreamID string `json:"streamId"`
	Phase    string `json:"phase"`
	Pct      int    `json:"pct"`
	Received *int   `json:"received,omitempty"`
	Total    *int   `json:"total,omitempty"`
}

// Clone implements git.clone — validates inputs, creates the destination
// directory, runs git clone with progress tracking, and emits
// git.clone.progress events (50 ms throttled, phase transitions immediate).
func (s *Service) Clone(ctx context.Context, raw json.RawMessage) (any, error) {
	var p CloneParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.clone params must include streamId, url, and parentDir")
	}
	if strings.TrimSpace(p.StreamID) == "" {
		return nil, proto.ProtocolError("git.clone streamId is required")
	}

	// Validate URL.
	if err := validateCloneURL(p.URL); err != nil {
		return nil, err
	}

	// Validate and resolve parentDir (must be an absolute, writable directory).
	parentDir, err := resolveCloneParentDir(p.ParentDir)
	if err != nil {
		return nil, err
	}

	// Determine folder name.
	name, err := resolveCloneName(p.Name, p.URL)
	if err != nil {
		return nil, err
	}

	absPath := filepath.Join(parentDir, name)

	// Security: ensure absPath stays inside parentDir (no path traversal).
	if filepath.Dir(absPath) != parentDir {
		return nil, proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneNameInvalid) + ": clone folder name is invalid",
		}
	}

	// Create the owned destination before spawning git.
	if err := os.Mkdir(absPath, 0o755); err != nil {
		if os.IsExist(err) {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  string(KindCloneDestinationExists) + ": clone destination already exists",
			}
		}
		if os.IsPermission(err) {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  string(KindCloneDestinationNotWritable) + ": clone destination is not writable",
			}
		}
		return nil, proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneDestinationInvalid) + ": " + err.Error(),
		}
	}

	// Register stream so git.cancel can abort it.
	streamCtx, cancel := context.WithCancel(ctx)
	if err := s.registerStream(p.StreamID, cancel); err != nil {
		cancel()
		_ = os.RemoveAll(absPath)
		return nil, err
	}
	defer s.unregisterStream(p.StreamID)

	// Build git clone arguments.
	args := buildCloneArgs(p.Branch, p.RecurseSubmodules, p.URL, absPath)

	cmd := exec.CommandContext(streamCtx, "git", args...)
	cmd.Dir = parentDir
	cmd.Env = gitEnv(p.Env, false, commandAskpass{})
	cmd.Stdout = io.Discard

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		_ = os.RemoveAll(absPath)
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}

	if err := cmd.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(absPath)
		return nil, mapGitStartError(err, args)
	}

	// Collect stderr for error classification while simultaneously parsing
	// progress lines and emitting events.
	var stderrBuf bytes.Buffer
	parseErr := s.emitCloneProgress(streamCtx, p.StreamID, stderrPipe, &stderrBuf)

	waitErr := cmd.Wait()

	// Context cancellation takes priority.
	if ctxErr := streamCtx.Err(); ctxErr != nil {
		_ = os.RemoveAll(absPath)
		return nil, ctxErr
	}

	if parseErr != nil && parseErr != io.EOF {
		_ = os.RemoveAll(absPath)
		return nil, parseErr
	}

	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		_ = os.RemoveAll(absPath)
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderrBuf.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		if strings.TrimSpace(msg) == "" {
			msg = strings.TrimSpace(stderrStr)
		}
		if msg == "" {
			msg = fmt.Sprintf("git clone exited with code %d", code)
		}
		_ = os.RemoveAll(absPath)
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	return CloneResult{AbsPath: absPath}, nil
}

// emitCloneProgress reads stderr from the clone process line-by-line,
// emits git.clone.progress events (with 50 ms throttle on same-phase
// progress, immediate on phase transitions), and tees the raw bytes
// into stderrBuf for later error classification.
func (s *Service) emitCloneProgress(ctx context.Context, streamID string, r io.Reader, stderrBuf *bytes.Buffer) error {
	var (
		mu         sync.Mutex // guards lastPhase + lastProgressAt
		lastPhase  = ""
		lastEmitAt time.Time
	)

	scanner := bufio.NewScanner(r)
	// Git progress lines can be long with appended speed info.
	scanner.Buffer(make([]byte, 512*1024), 512*1024)

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := scanner.Text()
		// Tee into stderr buffer for error classification.
		stderrBuf.WriteString(line)
		stderrBuf.WriteByte('\n')

		match := parseCloneProgressLine(line)
		if match == nil {
			continue
		}

		mu.Lock()
		phaseChanged := match.phase != lastPhase
		if phaseChanged {
			lastPhase = match.phase
		}
		now := time.Now()
		shouldEmitProgress := now.Sub(lastEmitAt) >= cloneProgressMinIntervalMs*time.Millisecond
		if shouldEmitProgress {
			lastEmitAt = now
		}
		mu.Unlock()

		// Phase transitions are always emitted (immediate, no throttle).
		if phaseChanged {
			s.emitCloneEvent(ctx, streamID, match.phase, -1, nil, nil)
		}
		// Progress sample within throttle window.
		if shouldEmitProgress {
			s.emitCloneEvent(ctx, streamID, match.phase, match.pct, match.received, match.total)
		}
	}
	return scanner.Err()
}

// emitCloneEvent sends one git.clone.progress event.
// When pct is -1, only the phase transition is sent (no pct/counts).
func (s *Service) emitCloneEvent(ctx context.Context, streamID string, phase string, pct int, received *int, total *int) {
	if err := ctx.Err(); err != nil {
		return
	}
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return
	}
	payload := CloneProgressPayload{
		StreamID: streamID,
		Phase:    phase,
		Pct:      pct,
		Received: received,
		Total:    total,
	}
	_ = sink("git.clone.progress", payload)
}

// cloneProgressMatch holds the parsed result of one git stderr progress line.
type cloneProgressMatch struct {
	phase    string
	pct      int
	received *int
	total    *int
}

// parseCloneProgressLine extracts phase/pct/counts from one Git stderr line.
// Returns nil if the line does not match any known progress pattern.
func parseCloneProgressLine(line string) *cloneProgressMatch {
	for _, pat := range cloneProgressPatterns {
		sub := pat.pattern.FindStringSubmatch(line)
		if sub == nil {
			continue
		}
		pct := clampClonePct(parseIntSafe(sub[1]))
		received := parseIntSafe(sub[2])
		total := parseIntSafe(sub[3])
		return &cloneProgressMatch{
			phase:    pat.phase,
			pct:      pct,
			received: &received,
			total:    &total,
		}
	}
	return nil
}

// validateCloneURL checks the URL against the allowed scheme list.
func validateCloneURL(url string) error {
	trimmed := strings.TrimSpace(url)
	if trimmed == "" {
		return proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneUrlInvalid) + ": clone URL is required",
		}
	}
	for _, allowed := range allowedCloneURLPrefixes {
		candidate := trimmed
		prefix := allowed.prefix
		if !allowed.caseSensitive {
			candidate = strings.ToLower(trimmed)
			prefix = strings.ToLower(allowed.prefix)
		}
		if strings.HasPrefix(candidate, prefix) {
			return nil
		}
	}
	return proto.CodedError{
		Code: proto.CodeRequestFailed,
		Msg:  string(KindCloneUrlInvalid) + ": unsupported clone URL scheme — use https://, http://, git://, ssh://, file://, or git@",
	}
}

// resolveCloneParentDir validates and cleans the parent directory path.
func resolveCloneParentDir(parentDir string) (string, error) {
	parentDir = strings.TrimSpace(parentDir)
	if parentDir == "" || !filepath.IsAbs(parentDir) {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneDestinationInvalid) + ": parentDir must be an absolute path",
		}
	}
	clean := filepath.Clean(parentDir)

	info, err := os.Stat(clean)
	if err != nil {
		if os.IsNotExist(err) {
			return "", proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  string(KindCloneDestinationInvalid) + ": clone parent directory does not exist",
			}
		}
		if os.IsPermission(err) {
			return "", proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  string(KindCloneDestinationNotWritable) + ": clone parent directory is not accessible",
			}
		}
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneDestinationInvalid) + ": " + err.Error(),
		}
	}
	if !info.IsDir() {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneDestinationInvalid) + ": clone parent is not a directory",
		}
	}
	if err := checkWritable(clean); err != nil {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneDestinationNotWritable) + ": clone parent directory is not writable",
		}
	}
	return clean, nil
}

// checkWritable checks whether the caller can write to dir without actually
// writing — it creates a temp file and removes it immediately.
func checkWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".nexus-clone-check-*")
	if err != nil {
		return err
	}
	_ = f.Close()
	_ = os.Remove(f.Name())
	return nil
}

// resolveCloneName derives and validates the destination folder name.
func resolveCloneName(name, url string) (string, error) {
	if name == "" {
		name = deriveCloneName(url)
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 255 || strings.HasPrefix(name, ".") || !cloneNamePattern.MatchString(name) {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  string(KindCloneNameInvalid) + ": clone folder name is invalid",
		}
	}
	return name, nil
}

// deriveCloneName extracts a default folder name from the URL, mirroring
// deriveCloneNameFromUrl in src/main/git/git-clone.ts.
func deriveCloneName(url string) string {
	trimmed := strings.TrimSpace(url)
	// Strip trailing slashes, query strings, fragments.
	if i := strings.IndexAny(trimmed, "?#"); i >= 0 {
		trimmed = trimmed[:i]
	}
	trimmed = strings.TrimRight(trimmed, "/?#")
	// Find last path segment (after the last / or :).
	lastSlash := strings.LastIndex(trimmed, "/")
	lastColon := strings.LastIndex(trimmed, ":")
	pivot := lastSlash
	if lastColon > lastSlash {
		pivot = lastColon
	}
	raw := trimmed
	if pivot >= 0 {
		raw = trimmed[pivot+1:]
	}
	if strings.HasSuffix(raw, ".git") {
		raw = raw[:len(raw)-4]
	}
	return raw
}

// buildCloneArgs assembles the git clone argument list.
func buildCloneArgs(branch string, recurseSubmodules bool, url, absPath string) []string {
	args := []string{"clone", "--progress"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	if recurseSubmodules {
		args = append(args, "--recurse-submodules")
	}
	args = append(args, url, absPath)
	return args
}

// clampClonePct keeps a git percentage inside [0, 100].
func clampClonePct(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// parseIntSafe parses a decimal string, returning 0 on error.
func parseIntSafe(s string) int {
	if s == "" {
		return 0
	}
	n := 0
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
	}
	return n
}
