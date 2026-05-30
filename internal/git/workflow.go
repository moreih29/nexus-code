package git

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Workflow RPC types
// ---------------------------------------------------------------------------

// WorkflowMergeParams carries the parameters for git.workflow.merge.
type WorkflowMergeParams struct {
	Cwd    string `json:"cwd"`
	Branch string `json:"branch"`
	Mode   string `json:"mode,omitempty"`
}

// WorkflowRebaseParams carries the parameters for git.workflow.rebase.
type WorkflowRebaseParams struct {
	Cwd  string `json:"cwd"`
	Onto string `json:"onto"`
}

// WorkflowCherryPickParams carries the parameters for git.workflow.cherryPick.
type WorkflowCherryPickParams struct {
	Cwd string `json:"cwd"`
	Sha string `json:"sha"`
}

// WorkflowAbortParams carries the parameters for git.workflow.abort.
type WorkflowAbortParams struct {
	Cwd string `json:"cwd"`
}

// WorkflowContinueParams carries the parameters for git.workflow.continue.
type WorkflowContinueParams struct {
	Cwd string `json:"cwd"`
}

// WorkflowResult is the envelope returned by merge/cherry-pick operations.
type WorkflowResult struct {
	Result        string `json:"result"`
	ConflictCount int    `json:"conflictCount,omitempty"`
	Conflicts     []any  `json:"conflicts,omitempty"`
	DoneCount     *int   `json:"doneCount,omitempty"`
	TotalCount    *int   `json:"totalCount,omitempty"`
}

// ---------------------------------------------------------------------------
// Internal helpers for reading status and operation-state without RPC
// ---------------------------------------------------------------------------

// statusCore runs git status porcelain-v2 in cwd and returns the parsed result.
// It intentionally omits remotes/stash/tag subcalls that the external Status
// RPC includes; workflow operations only need the merge list and operation-state.
func (s *Service) statusCore(ctx context.Context, cwd string) (GitStatus, error) {
	args := []string{"status", "--porcelain=v2", "-z", "-b", "--untracked-files=all", "--renames"}
	stdout, err := s.statusGitOutput(ctx, cwd, args...)
	if err != nil {
		return GitStatus{}, err
	}
	status, err := ParsePorcelainV2(stdout)
	if err != nil {
		return GitStatus{}, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}
	// Attach operation state so callers can read conflictCount from operationState.
	gitDir, err := s.resolveGitDirFromCwd(ctx, cwd)
	if err != nil {
		return GitStatus{}, err
	}
	opState, err := readOperationState(gitDir, len(status.Merge))
	if err != nil {
		return GitStatus{}, err
	}
	status.OperationState = opState
	return status, nil
}

// resolveGitDirFromCwd asks git for the absolute git dir for a given cwd.
func (s *Service) resolveGitDirFromCwd(ctx context.Context, cwd string) (string, error) {
	out, err := s.statusGitOutput(ctx, cwd, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// runWorkflowGit runs a git command in cwd and returns stdout+stderr+code.
func (s *Service) runWorkflowGit(ctx context.Context, cwd string, args []string) (string, string, int, error) {
	return s.capture(ctx, cwd, args, false)
}

// ---------------------------------------------------------------------------
// Conflict detection helpers
// ---------------------------------------------------------------------------

// isConflictExit returns true when the exit code + combined output indicate
// that a git operation paused due to conflicts rather than truly failing.
// Git reports conflict details on stdout (not stderr) for merge and cherry-pick,
// so both streams must be checked.
func isConflictExit(code int, stdout, stderr string) bool {
	if code == 0 {
		return false
	}
	kind := Classify(stderr)
	if kind == KindConflict || kind == KindUnresolvedConflicts {
		return true
	}
	combined := strings.ToLower(stdout + " " + stderr)
	return strings.Contains(combined, "conflict") ||
		strings.Contains(combined, "automatic merge failed")
}

// ---------------------------------------------------------------------------
// WorkflowMerge — git.workflow.merge
// ---------------------------------------------------------------------------

// WorkflowMerge starts a merge and returns a clean/conflicts result envelope.
// Conflicts are returned as a success payload so the caller can render conflict
// UI without treating them as transport failures.
func (s *Service) WorkflowMerge(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WorkflowMergeParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.workflow.merge params must include cwd and branch")
	}
	if strings.TrimSpace(p.Branch) == "" {
		return nil, proto.ProtocolError("git.workflow.merge branch is required")
	}

	// Check for already-in-progress operation before starting.
	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	opKind := operationKind(status.OperationState)
	if opKind != "none" {
		return nil, workflowAlreadyInProgressError(opKind)
	}

	args := buildMergeArgs(strings.TrimSpace(p.Branch), p.Mode)
	stdout, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, args)
	if runErr != nil {
		return nil, runErr
	}

	if code == 0 {
		return WorkflowResult{Result: "clean"}, nil
	}

	if !isConflictExit(code, stdout, stderr) {
		return nil, workflowGitError(args, stderr, code)
	}

	// Re-read status to get conflict count.
	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	if len(refreshed.Merge) == 0 {
		return nil, workflowGitError(args, stderr, code)
	}
	return WorkflowResult{Result: "conflicts", ConflictCount: len(refreshed.Merge)}, nil
}

// buildMergeArgs constructs the git merge argv for the requested mode.
func buildMergeArgs(branch, mode string) []string {
	switch mode {
	case "no-ff":
		return []string{"merge", "--no-ff", "--no-edit", branch}
	case "squash":
		return []string{"merge", "--squash", branch}
	case "no-commit":
		return []string{"merge", "--no-commit", branch}
	case "ff-only":
		return []string{"merge", "--ff-only", branch}
	default: // "default" or ""
		return []string{"merge", "--no-edit", branch}
	}
}

// ---------------------------------------------------------------------------
// WorkflowRebase — git.workflow.rebase
// ---------------------------------------------------------------------------

// WorkflowRebase starts a non-interactive rebase and returns progress counters.
func (s *Service) WorkflowRebase(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WorkflowRebaseParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.workflow.rebase params must include cwd and onto")
	}
	onto := strings.TrimSpace(p.Onto)
	if onto == "" {
		return nil, proto.ProtocolError("git.workflow.rebase onto is required")
	}

	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	if kind := operationKind(status.OperationState); kind != "none" {
		return nil, workflowAlreadyInProgressError(kind)
	}

	// Count commits to replay so we can report totalCount on clean completion.
	totalCount := s.countRebaseCommits(ctx, p.Cwd, onto)

	_, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, []string{"rebase", onto})
	if runErr != nil {
		return nil, runErr
	}

	if code == 0 {
		done := totalCount
		total := totalCount
		return WorkflowResult{
			Result:        "clean",
			ConflictCount: 0,
			DoneCount:     &done,
			TotalCount:    &total,
		}, nil
	}

	if !isConflictExit(code, "", stderr) {
		return nil, workflowGitError([]string{"rebase", onto}, stderr, code)
	}

	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	opState := refreshed.OperationState
	if operationKind(opState) == "rebase" {
		done := 0
		total := totalCount
		conflictCount := len(refreshed.Merge)
		if d, ok := opState["doneCount"]; ok {
			done = toInt(d)
		}
		if t, ok := opState["totalCount"]; ok {
			total = toInt(t)
		}
		if cc, ok := opState["conflictCount"]; ok {
			conflictCount = toInt(cc)
		}
		return WorkflowResult{
			Result:        "conflicts",
			ConflictCount: conflictCount,
			DoneCount:     &done,
			TotalCount:    &total,
		}, nil
	}
	return nil, workflowGitError([]string{"rebase", onto}, stderr, code)
}

// countRebaseCommits counts how many commits would be replayed.
func (s *Service) countRebaseCommits(ctx context.Context, cwd, onto string) int {
	out, err := s.statusGitOutput(ctx, cwd, "rev-list", "--count", onto+"..HEAD")
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// ---------------------------------------------------------------------------
// WorkflowCherryPick — git.workflow.cherryPick
// ---------------------------------------------------------------------------

// WorkflowCherryPick cherry-picks one commit and returns a conflict envelope
// instead of an error when the pick produces conflicts.
func (s *Service) WorkflowCherryPick(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WorkflowCherryPickParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.workflow.cherryPick params must include cwd and sha")
	}
	sha := strings.TrimSpace(p.Sha)
	if sha == "" {
		return nil, proto.ProtocolError("git.workflow.cherryPick sha is required")
	}

	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	if kind := operationKind(status.OperationState); kind != "none" {
		return nil, workflowAlreadyInProgressError(kind)
	}

	args := []string{"cherry-pick", sha}
	stdout, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, args)
	if runErr != nil {
		return nil, runErr
	}

	if code == 0 {
		return WorkflowResult{Result: "clean"}, nil
	}

	if !isConflictExit(code, stdout, stderr) {
		return nil, workflowGitError(args, stderr, code)
	}

	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	if len(refreshed.Merge) == 0 {
		return nil, workflowGitError(args, stderr, code)
	}
	return WorkflowResult{Result: "conflicts", ConflictCount: len(refreshed.Merge)}, nil
}

// ---------------------------------------------------------------------------
// WorkflowAbort — git.workflow.abort
// ---------------------------------------------------------------------------

// WorkflowAbort aborts the currently-active workflow operation by detecting
// which operation marker files exist in the git dir.
func (s *Service) WorkflowAbort(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WorkflowAbortParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.workflow.abort params must include cwd")
	}

	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	kind := operationKind(status.OperationState)
	if kind == "none" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "no-operation-in-progress: No Git operation is in progress."}
	}

	args := abortArgs(kind)
	_, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, args)
	if runErr != nil {
		return nil, runErr
	}
	if code != 0 {
		return nil, workflowGitError(args, stderr, code)
	}
	return nil, nil
}

// abortArgs builds the --abort argv for the given operation kind.
func abortArgs(kind string) []string {
	switch kind {
	case "merge":
		return []string{"merge", "--abort"}
	case "rebase":
		return []string{"rebase", "--abort"}
	case "cherry-pick":
		return []string{"cherry-pick", "--abort"}
	case "revert":
		return []string{"revert", "--abort"}
	default:
		return []string{"merge", "--abort"}
	}
}

// ---------------------------------------------------------------------------
// WorkflowContinue — git.workflow.continue
// ---------------------------------------------------------------------------

// WorkflowContinue continues the currently-active workflow operation.
func (s *Service) WorkflowContinue(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WorkflowContinueParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.workflow.continue params must include cwd")
	}

	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	kind := operationKind(status.OperationState)
	if kind == "none" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "no-operation-in-progress: No Git operation is in progress."}
	}
	conflictCount := 0
	if cc, ok := status.OperationState["conflictCount"]; ok {
		conflictCount = toInt(cc)
	}
	if conflictCount > 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "unresolved-conflicts: Resolve conflicts before continuing."}
	}

	args := continueArgs(kind)
	contStdout, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, args)
	if runErr != nil {
		return nil, runErr
	}

	if code != 0 {
		if !isConflictExit(code, contStdout, stderr) {
			return nil, workflowGitError(args, stderr, code)
		}
		// Hit another conflict on continue.
		refreshed, err := s.statusCore(ctx, p.Cwd)
		if err != nil {
			return nil, err
		}
		newKind := operationKind(refreshed.OperationState)
		if newKind != "none" {
			newCC := 0
			if v, ok := refreshed.OperationState["conflictCount"]; ok {
				newCC = toInt(v)
			}
			if newCC > 0 {
				return WorkflowResult{Result: "conflicts", ConflictCount: newCC}, nil
			}
		}
		return nil, workflowGitError(args, stderr, code)
	}

	// Successful continue — check if the operation is complete.
	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	return continueResult(refreshed.OperationState), nil
}

// continueArgs builds the --continue argv for the given operation kind.
func continueArgs(kind string) []string {
	switch kind {
	case "merge":
		return []string{"commit", "--no-edit"}
	case "rebase":
		return []string{"rebase", "--continue"}
	case "cherry-pick":
		return []string{"cherry-pick", "--continue"}
	case "revert":
		return []string{"revert", "--continue"}
	default:
		return []string{"rebase", "--continue"}
	}
}

// continueResult converts the post-continue operation state to a result envelope.
func continueResult(opState map[string]any) WorkflowResult {
	kind := operationKind(opState)
	if kind == "none" {
		return WorkflowResult{Result: "completed"}
	}
	cc := 0
	if v, ok := opState["conflictCount"]; ok {
		cc = toInt(v)
	}
	if cc > 0 {
		return WorkflowResult{Result: "conflicts", ConflictCount: cc}
	}
	return WorkflowResult{Result: "clean", ConflictCount: 0}
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

// operationKind extracts the "kind" string from an operation state map.
func operationKind(state map[string]any) string {
	if state == nil {
		return "none"
	}
	kind, _ := state["kind"].(string)
	if kind == "" {
		return "none"
	}
	return kind
}

// workflowAlreadyInProgressError maps an active operation kind to the correct
// typed error message the TS classifier recognizes.
func workflowAlreadyInProgressError(kind string) error {
	switch kind {
	case "merge":
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "merge-already-in-progress: A merge is already in progress."}
	case "rebase":
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "rebase-already-in-progress: A rebase is already in progress."}
	case "cherry-pick":
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "cherry-pick-already-in-progress: A cherry-pick is already in progress."}
	case "revert":
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "unresolved-conflicts: A revert is already in progress."}
	default:
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "merge-already-in-progress: A workflow operation is already in progress."}
	}
}

// workflowGitError builds an error from a non-conflict non-zero git exit.
// Delegates to the shared gitError helper in run.go.
func workflowGitError(args []string, stderr string, code int) error {
	return gitError(args, stderr, code)
}

// toInt coerces a json.Number or float64 from an unmarshalled map to int.
func toInt(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case float64:
		return int(x)
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}
