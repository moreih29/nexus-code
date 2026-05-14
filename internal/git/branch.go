package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// BranchCreateParams carries the parameters for git.branch.create.
type BranchCreateParams struct {
	Cwd      string `json:"cwd,omitempty"`
	Name     string `json:"name"`
	Checkout bool   `json:"checkout,omitempty"`
	StartRef string `json:"startRef,omitempty"`
}

// BranchDeleteParams carries the parameters for git.branch.delete.
type BranchDeleteParams struct {
	Cwd   string `json:"cwd,omitempty"`
	Name  string `json:"name"`
	Force bool   `json:"force,omitempty"`
}

// BranchDeleteResult is returned by git.branch.delete. On success, both fields
// are empty. On classifiable failure, ErrorKind and ErrorHint are populated so
// the TS executor can surface a typed GitError with the branch name in the hint.
type BranchDeleteResult struct {
	ErrorKind    Kind        `json:"errorKind,omitempty"`
	ErrorMessage string      `json:"errorMessage,omitempty"`
	ErrorHint    *ActionHint `json:"errorHint,omitempty"`
}

// BranchDeleteRemoteParams carries the parameters for git.branch.deleteRemote.
type BranchDeleteRemoteParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote"`
	Name   string `json:"name"`
}

// BranchRenameParams carries the parameters for git.branch.rename.
type BranchRenameParams struct {
	Cwd  string `json:"cwd,omitempty"`
	From string `json:"from"`
	To   string `json:"to"`
}

// BranchSetUpstreamParams carries the parameters for git.branch.setUpstream.
// Upstream is nil to unset, non-nil to set.
type BranchSetUpstreamParams struct {
	Cwd      string  `json:"cwd,omitempty"`
	Branch   string  `json:"branch"`
	Upstream *string `json:"upstream"`
}

// BranchFastForwardParams carries the parameters for git.branch.fastForward.
type BranchFastForwardParams struct {
	Cwd       string `json:"cwd,omitempty"`
	Branch    string `json:"branch"`
	Remote    string `json:"remote"`
	RemoteRef string `json:"remoteRef"`
}

// BranchFastForwardResult carries before/after SHAs for git.branch.fastForward.
type BranchFastForwardResult struct {
	Advanced bool   `json:"advanced"`
	FromSha  string `json:"fromSha"`
	ToSha    string `json:"toSha"`
}

// BranchCreate creates a new branch, optionally checking it out.
func (s *Service) BranchCreate(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchCreateParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.create params must include name")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "branch name is required"}
	}
	if strings.Contains(p.Name, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.create params must not contain NUL")
	}

	// Resolve the start point if provided.
	startRef := ""
	if trimmed := strings.TrimSpace(p.StartRef); trimmed != "" {
		resolved, err := s.resolveCreateBranchStartRef(ctx, p.Cwd, trimmed)
		if err != nil {
			return nil, err
		}
		startRef = resolved
	}

	var args []string
	if p.Checkout {
		args = []string{"checkout", "-b", p.Name}
	} else {
		args = []string{"branch", p.Name}
	}
	if startRef != "" {
		args = append(args, startRef)
	}

	if err := s.runBranchCommand(ctx, args, p.Cwd, false); err != nil {
		return nil, err
	}
	return nil, nil
}

// BranchDelete deletes a local branch. When the branch is not fully merged and
// force is false, the result body carries errorKind/errorHint so the TS executor
// can surface a typed GitError with the force-delete hint — matching the old
// withBranchDeleteHint pattern without extending the proto envelope.
func (s *Service) BranchDelete(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchDeleteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.delete params must include name")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "branch name is required"}
	}
	if strings.Contains(p.Name, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.delete params must not contain NUL")
	}

	flag := "-d"
	if p.Force {
		flag = "-D"
	}
	args := []string{"branch", flag, p.Name}

	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(runErr)
	if fatal != nil {
		return nil, fatal
	}
	if code == 0 {
		return BranchDeleteResult{}, nil
	}

	stderrStr := stderr.String()
	kind := Classify(stderrStr)
	message := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
	if strings.TrimSpace(message) == "" {
		message = strings.TrimSpace(stderrStr)
	}

	// Attach force-delete hint for not-fully-merged errors.
	var hint *ActionHint
	if kind == KindBranchNotFullyMerged || kind == KindBranchNotMerged {
		hint = &ActionHint{Kind: "force-delete-available", Branch: p.Name}
	}
	return BranchDeleteResult{
		ErrorKind:    kind,
		ErrorMessage: message,
		ErrorHint:    hint,
	}, nil
}

// BranchDeleteRemote deletes a remote branch via push with askpass helpers.
func (s *Service) BranchDeleteRemote(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchDeleteRemoteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.deleteRemote params must include remote and name")
	}
	p.Remote = strings.TrimSpace(p.Remote)
	p.Name = strings.TrimSpace(p.Name)
	if p.Remote == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "remote name is required"}
	}
	if p.Name == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "branch name is required"}
	}
	if strings.Contains(p.Remote, "\x00") || strings.Contains(p.Name, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.deleteRemote params must not contain NUL")
	}

	if err := s.runBranchCommand(ctx, []string{"push", p.Remote, "--delete", p.Name}, p.Cwd, true); err != nil {
		return nil, err
	}
	return nil, nil
}

// BranchRename renames a local branch.
func (s *Service) BranchRename(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchRenameParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.rename params must include from and to")
	}
	p.From = strings.TrimSpace(p.From)
	p.To = strings.TrimSpace(p.To)
	if p.From == "" || p.To == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "from and to branch names are required"}
	}
	if strings.Contains(p.From, "\x00") || strings.Contains(p.To, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.rename params must not contain NUL")
	}

	if err := s.runBranchCommand(ctx, []string{"branch", "-m", p.From, p.To}, p.Cwd, false); err != nil {
		return nil, err
	}
	return nil, nil
}

// BranchSetUpstream sets or unsets the upstream tracking ref for a branch.
func (s *Service) BranchSetUpstream(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchSetUpstreamParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.setUpstream params must include branch")
	}
	p.Branch = strings.TrimSpace(p.Branch)
	if p.Branch == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "branch name is required"}
	}
	if strings.Contains(p.Branch, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.setUpstream params must not contain NUL")
	}

	var args []string
	if p.Upstream == nil {
		args = []string{"branch", "--unset-upstream", p.Branch}
	} else {
		upstream := strings.TrimSpace(*p.Upstream)
		if upstream == "" {
			return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "upstream ref is required"}
		}
		if strings.Contains(upstream, "\x00") {
			return nil, proto.ProtocolError("git.branch.setUpstream upstream must not contain NUL")
		}
		args = []string{"branch", "--set-upstream-to", upstream, p.Branch}
	}

	if err := s.runBranchCommand(ctx, args, p.Cwd, false); err != nil {
		return nil, err
	}
	return nil, nil
}

// BranchFastForward fetches a remote ref and fast-forwards a local branch.
// It returns before/after SHAs so callers can detect whether the branch advanced.
func (s *Service) BranchFastForward(ctx context.Context, raw json.RawMessage) (any, error) {
	var p BranchFastForwardParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.branch.fastForward params must include branch, remote, and remoteRef")
	}
	p.Branch = strings.TrimSpace(p.Branch)
	p.Remote = strings.TrimSpace(p.Remote)
	p.RemoteRef = strings.TrimSpace(p.RemoteRef)
	if p.Branch == "" || p.Remote == "" || p.RemoteRef == "" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "branch, remote, and remoteRef are required"}
	}
	if strings.Contains(p.Branch, "\x00") || strings.Contains(p.Remote, "\x00") ||
		strings.Contains(p.RemoteRef, "\x00") || strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.branch.fastForward params must not contain NUL")
	}

	fromSha, err := s.branchRevParse(ctx, p.Cwd, p.Branch)
	if err != nil {
		return nil, err
	}

	fetchRef := normalizeBranchFetchRef(p.Remote, p.RemoteRef)

	currentBranch, err := s.readCurrentBranch(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}

	if currentBranch == p.Branch {
		// Checked-out branch: fetch to FETCH_HEAD then ff-only merge.
		if err := s.runBranchCommand(ctx, []string{"fetch", p.Remote, fetchRef}, p.Cwd, true); err != nil {
			return nil, err
		}
		if err := s.runBranchCommand(ctx, []string{"merge", "--ff-only", "FETCH_HEAD"}, p.Cwd, false); err != nil {
			return nil, err
		}
	} else {
		// Non-checked-out branch: use refspec to update the ref directly.
		refspec := fmt.Sprintf("%s:refs/heads/%s", fetchRef, p.Branch)
		if err := s.runBranchCommand(ctx, []string{"fetch", p.Remote, refspec}, p.Cwd, true); err != nil {
			return nil, err
		}
	}

	toSha, err := s.branchRevParse(ctx, p.Cwd, p.Branch)
	if err != nil {
		return nil, err
	}

	return BranchFastForwardResult{
		Advanced: fromSha != toSha,
		FromSha:  fromSha,
		ToSha:    toSha,
	}, nil
}

// runBranchCommand executes one git branch command and converts non-zero exits to
// typed errors via the stderr classifier.
func (s *Service) runBranchCommand(ctx context.Context, args []string, cwd string, interactive bool) error {
	cmd, err := s.command(ctx, args, cwd, nil, interactive)
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return fatal
	}
	if code != 0 {
		return branchGitError(args, stderr.String(), code)
	}
	return nil
}

// branchGitError converts a non-zero git exit into a typed CodedError.
func branchGitError(args []string, stderr string, code int) error {
	kind := Classify(stderr)
	message := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
	if strings.TrimSpace(message) == "" {
		message = strings.TrimSpace(stderr)
	}
	if message == "" {
		message = fmt.Sprintf("git %s exited with code %d", strings.Join(args, " "), code)
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: message}
}

// branchRevParse reads the SHA for a branch via --verify.
func (s *Service) branchRevParse(ctx context.Context, cwd, ref string) (string, error) {
	cmd, err := s.command(ctx, []string{"rev-parse", "--verify", ref}, cwd, nil, false)
	if err != nil {
		return "", err
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", ctxErr
	}
	code, fatal := gitExitCode(runErr)
	if fatal != nil {
		return "", fatal
	}
	if code != 0 {
		return "", branchGitError([]string{"rev-parse", "--verify", ref}, stderr.String(), code)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// readCurrentBranch returns the currently checked-out branch name, or "" for
// detached HEAD or unborn repos.
func (s *Service) readCurrentBranch(ctx context.Context, cwd string) (string, error) {
	cmd, err := s.command(ctx, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, cwd, nil, false)
	if err != nil {
		return "", err
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", ctxErr
	}
	code, fatal := gitExitCode(runErr)
	if fatal != nil {
		return "", fatal
	}
	if code != 0 {
		// Detached HEAD or unborn repo: not an error for our purposes.
		return "", nil
	}
	return strings.TrimSpace(stdout.String()), nil
}

// resolveCreateBranchStartRef resolves a start-point ref for branch creation.
// Remote short names (e.g. "origin/main") are expanded to the full remote-tracking
// ref; plain SHAs and tags pass through unchanged.
func (s *Service) resolveCreateBranchStartRef(ctx context.Context, cwd, fromRef string) (string, error) {
	// Fetch local and remote branch names.
	localOut, err := s.branchListOutput(ctx, cwd, false)
	if err != nil {
		return fromRef, nil // fall through on error — git will validate
	}
	remoteOut, err2 := s.branchListOutput(ctx, cwd, true)
	if err2 != nil {
		return fromRef, nil
	}

	localBranches := parseNonemptyLines(localOut)
	remoteBranches := parseNonemptyLines(remoteOut)

	// Local branch takes priority.
	for _, b := range localBranches {
		if b == fromRef {
			return fromRef, nil
		}
	}

	// Look for a unique remote match.
	var remoteMatches []string
	for _, r := range remoteBranches {
		slash := strings.Index(r, "/")
		if slash >= 0 && r[slash+1:] == fromRef {
			remoteMatches = append(remoteMatches, r)
		}
	}
	if len(remoteMatches) == 1 {
		return remoteMatches[0], nil
	}
	if len(remoteMatches) > 1 {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  fmt.Sprintf("'%s' is ambiguous — multiple remotes provide it", fromRef),
		}
	}

	// Not a branch name: pass through as-is (tag, SHA, etc.).
	return fromRef, nil
}

// branchListOutput runs `git branch --format=%(refname:short)` and returns stdout.
func (s *Service) branchListOutput(ctx context.Context, cwd string, remotes bool) (string, error) {
	args := []string{"branch", "--format=%(refname:short)"}
	if remotes {
		args = append(args, "--remotes")
	} else {
		args = append(args, "--list")
	}
	cmd, err := s.command(ctx, args, cwd, nil, false)
	if err != nil {
		return "", err
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if runErr := cmd.Run(); runErr != nil {
		return "", nil // non-fatal fallthrough
	}
	return stdout.String(), nil
}

// normalizeBranchFetchRef converts an upstream-style ref (e.g. "origin/main")
// into the remote-side ref name ("main") accepted by `git fetch <remote> <ref>`.
func normalizeBranchFetchRef(remote, remoteRef string) string {
	if strings.HasPrefix(remoteRef, "refs/") {
		return remoteRef
	}
	prefix := remote + "/"
	if strings.HasPrefix(remoteRef, prefix) {
		return remoteRef[len(prefix):]
	}
	return remoteRef
}
