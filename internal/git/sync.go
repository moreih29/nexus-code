package git

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

type PullParams struct {
	Cwd   string   `json:"cwd,omitempty"`
	Args  []string `json:"args,omitempty"`
	RunID string   `json:"runId,omitempty"`
}

type PullResult struct {
	AlreadyUpToDate bool   `json:"alreadyUpToDate"`
	FastForward     *bool  `json:"fastForward,omitempty"`
	FilesChanged    *int   `json:"filesChanged,omitempty"`
	Insertions      *int   `json:"insertions,omitempty"`
	Deletions       *int   `json:"deletions,omitempty"`
	Summary         string `json:"summary,omitempty"`
}

type PushParams struct {
	Cwd     string   `json:"cwd,omitempty"`
	Force   bool     `json:"force,omitempty"`
	Publish bool     `json:"publish,omitempty"`
	Args    []string `json:"args,omitempty"`
	RunID   string   `json:"runId,omitempty"`
}

type PushResult struct {
	Pushed        bool   `json:"pushed"`
	Remote        string `json:"remote,omitempty"`
	Branch        string `json:"branch,omitempty"`
	CommitsPushed *int   `json:"commitsPushed,omitempty"`
	Summary       string `json:"summary,omitempty"`
}

func (s *Service) Pull(ctx context.Context, raw json.RawMessage) (any, error) {
	var p PullParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	ctx, done, err := s.startRun(ctx, p.RunID)
	if err != nil {
		return nil, err
	}
	defer done()

	args := []string{"pull", "--no-edit"}
	_, _, configCode, err := s.capture(ctx, p.Cwd, []string{"config", "--get", "pull.ff"}, false)
	if err != nil {
		return nil, err
	}
	if configCode == 1 {
		args = append(args, "--ff")
	}
	if len(p.Args) > 0 {
		args = append(args, p.Args...)
	}

	stdout, stderr, code, err := s.runSyncGit(ctx, p.Cwd, args, true)
	if err != nil {
		return nil, err
	}

	if code != 0 {
		if isConflictExit(code, stdout, stderr) {
			return nil, classifiedFailure(KindConflict, "Pull produced conflicts — resolve them before continuing.")
		}
		kind := Classify(stderr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
		if strings.TrimSpace(msg) == "" {
			msg = strings.TrimSpace(stderr)
		}
		if msg == "" {
			msg = "git pull exited with code " + strconv.Itoa(code)
		}
		return nil, classifiedFailure(kind, msg)
	}

	return parsePullOutput(stdout, stderr), nil
}

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

func (s *Service) Push(ctx context.Context, raw json.RawMessage) (any, error) {
	var p PushParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	args := buildPushArgs(p)

	ctx, done, err := s.startRun(ctx, p.RunID)
	if err != nil {
		return nil, err
	}
	defer done()

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
		return nil, classifiedFailure(kind, msg)
	}

	return parsePushOutput(stdout, stderr), nil
}

func buildPushArgs(p PushParams) []string {
	if len(p.Args) > 0 {
		return p.Args
	}
	if p.Force {
		return []string{"push", "--force-with-lease"}
	}
	return []string{"push"}
}

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

func (s *Service) runSyncGit(ctx context.Context, cwd string, args []string, interactive bool) (string, string, int, error) {
	cmd, err := s.command(ctx, args, cwd, nil, interactive)
	if err != nil {
		return "", "", 0, err
	}
	stdout, stderr, code, fatal := runCapturedCommand(ctx, cmd)
	if fatal != nil {
		return "", "", 0, fatal
	}
	return stdout, stderr, code, nil
}

func nonEmpty(parts ...string) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
