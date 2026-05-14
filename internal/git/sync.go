package git

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Pull/Push RPC types
// ---------------------------------------------------------------------------

// PullParams carries the parameters for git.pull.
type PullParams struct {
	Cwd  string   `json:"cwd,omitempty"`
	Args []string `json:"args,omitempty"`
}

// PullResult mirrors src/shared/types/git.ts PullResultSchema.
type PullResult struct {
	AlreadyUpToDate bool   `json:"alreadyUpToDate"`
	FastForward     *bool  `json:"fastForward,omitempty"`
	FilesChanged    *int   `json:"filesChanged,omitempty"`
	Insertions      *int   `json:"insertions,omitempty"`
	Deletions       *int   `json:"deletions,omitempty"`
	Summary         string `json:"summary,omitempty"`
}

// PushParams carries the parameters for git.push.
type PushParams struct {
	Cwd     string   `json:"cwd,omitempty"`
	Force   bool     `json:"force,omitempty"`
	Publish bool     `json:"publish,omitempty"`
	Args    []string `json:"args,omitempty"`
}

// PushResult mirrors src/shared/types/git.ts PushResultSchema.
type PushResult struct {
	Pushed        bool   `json:"pushed"`
	Remote        string `json:"remote,omitempty"`
	Branch        string `json:"branch,omitempty"`
	CommitsPushed *int   `json:"commitsPushed,omitempty"`
	Summary       string `json:"summary,omitempty"`
}

// ---------------------------------------------------------------------------
// Pull — git.pull
// ---------------------------------------------------------------------------

// Pull executes git pull and returns a PullResult envelope. Conflicts are
// surfaced as a typed error so the TS layer can map them to GitSyncError.
func (s *Service) Pull(ctx context.Context, raw json.RawMessage) (any, error) {
	var p PullParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	args := []string{"pull", "--no-edit"}
	if len(p.Args) > 0 {
		args = append(args, p.Args...)
	}

	stdout, stderr, code, err := s.runSyncGit(ctx, p.Cwd, args, true)
	if err != nil {
		return nil, err
	}

	if code != 0 {
		if isConflictExit(code, stdout, stderr) {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  "conflict: Pull produced conflicts — resolve them before continuing.",
			}
		}
		kind := Classify(stderr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
		if strings.TrimSpace(msg) == "" {
			msg = strings.TrimSpace(stderr)
		}
		if msg == "" {
			msg = "git pull exited with code " + strconv.Itoa(code)
		}
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	return parsePullOutput(stdout, stderr), nil
}

// parsePullOutput builds a PullResult from successful git pull stdout+stderr.
func parsePullOutput(stdout, stderr string) PullResult {
	combined := strings.Join(nonEmpty(stdout, stderr), "\n")
	result := PullResult{Summary: combined}

	lower := strings.ToLower(combined)
	result.AlreadyUpToDate = strings.Contains(lower, "already up-to-date") ||
		strings.Contains(lower, "already up to date")

	if ffRE.MatchString(combined) {
		t := true
		result.FastForward = &t
	}

	if m := filesChangedRE.FindStringSubmatch(combined); m != nil {
		n, _ := strconv.Atoi(m[1])
		result.FilesChanged = &n
	}
	if m := insertionsRE.FindStringSubmatch(combined); m != nil {
		n, _ := strconv.Atoi(m[1])
		result.Insertions = &n
	}
	if m := deletionsRE.FindStringSubmatch(combined); m != nil {
		n, _ := strconv.Atoi(m[1])
		result.Deletions = &n
	}

	return result
}

var (
	ffRE           = regexp.MustCompile(`(?i)fast-forward`)
	filesChangedRE = regexp.MustCompile(`(\d+) files? changed`)
	insertionsRE   = regexp.MustCompile(`(\d+) insertions?\(\+\)`)
	deletionsRE    = regexp.MustCompile(`(\d+) deletions?\(-\)`)
)

// ---------------------------------------------------------------------------
// Push — git.push
// ---------------------------------------------------------------------------

// Push executes git push and returns a PushResult envelope.
// When publish=true the caller must supply cwd that resolves to a repo with
// at least one commit (assertHasHead equivalent is the TS caller's responsibility).
func (s *Service) Push(ctx context.Context, raw json.RawMessage) (any, error) {
	var p PushParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	args := buildPushArgs(p)

	stdout, stderr, code, err := s.runSyncGit(ctx, p.Cwd, args, true)
	if err != nil {
		return nil, err
	}

	if code != 0 {
		kind := Classify(stderr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
		if strings.TrimSpace(msg) == "" {
			msg = strings.TrimSpace(stderr)
		}
		if msg == "" {
			msg = "git push exited with code " + strconv.Itoa(code)
		}
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	return parsePushOutput(stdout, stderr), nil
}

// buildPushArgs constructs the push argv from PushParams. The publish/force
// paths mirror the TS git-repository.ts push() method logic; the TS caller
// still resolves the remote/branch from status for publish mode and passes
// them via Args.
func buildPushArgs(p PushParams) []string {
	if len(p.Args) > 0 {
		return p.Args
	}
	if p.Force {
		return []string{"push", "--force-with-lease"}
	}
	return []string{"push"}
}

// parsePushOutput builds a PushResult from successful git push stdout+stderr.
func parsePushOutput(stdout, stderr string) PushResult {
	combined := strings.Join(nonEmpty(stdout, stderr), "\n")
	lower := strings.ToLower(combined)
	pushed := !strings.Contains(lower, "everything up-to-date") &&
		!strings.Contains(lower, "everything up to date")
	return PushResult{
		Pushed:  pushed,
		Summary: combined,
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// runSyncGit runs a git pull or push command with optional interactive askpass.
func (s *Service) runSyncGit(ctx context.Context, cwd string, args []string, interactive bool) (string, string, int, error) {
	cmd, err := s.command(ctx, args, cwd, nil, interactive)
	if err != nil {
		return "", "", 0, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", "", 0, ctxErr
	}
	code, fatal := gitExitCode(runErr)
	if fatal != nil {
		return "", "", 0, fatal
	}
	return stdout.String(), stderr.String(), code, nil
}

// nonEmpty filters empty strings for summary joining.
func nonEmpty(parts ...string) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
