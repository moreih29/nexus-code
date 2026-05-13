package git

import (
	"fmt"
	"strconv"
	"strings"
)

// MessageContext supplies process details used when stderr is empty.
type MessageContext struct {
	Stderr     string
	Args       []string
	ExitCode   *int
	Signal     string
	LimitBytes int64
}

// Classify maps Git stderr to the closest renderer-visible GitErrorKind.
func Classify(stderr string) Kind {
	if authRequiredStderrPatterns.Matches(stderr) {
		return KindAuthRequired
	}
	if authStderrPatterns.Matches(stderr) {
		return KindAuth
	}
	if lockBusyStderrPatterns.Matches(stderr) {
		return KindLockBusy
	}
	if localChangesOverwrittenStderrPatterns.Matches(stderr) {
		return KindLocalChangesOverwritten
	}
	if gitignoreWriteFailedStderrPatterns.Matches(stderr) {
		return KindGitignoreWriteFailed
	}
	if commitAbortedStderrPatterns.Matches(stderr) {
		return KindCommitAborted
	}
	if signingFailedStderrPatterns.Matches(stderr) {
		return KindSigningFailed
	}
	if noParentStderrPatterns.Matches(stderr) {
		return KindNoParent
	}
	if binaryTooLargeStderrPatterns.Matches(stderr) {
		return KindBinaryTooLarge
	}
	if fileNotInHeadStderrPatterns.Matches(stderr) {
		return KindFileNotInHead
	}
	if pathNotInRepoStderrPatterns.Matches(stderr) {
		return KindPathNotInRepo
	}
	if mergeAlreadyInProgressStderrPatterns.Matches(stderr) {
		return KindMergeAlreadyInProgress
	}
	if rebaseAlreadyInProgressStderrPatterns.Matches(stderr) {
		return KindRebaseAlreadyInProgress
	}
	if cherryPickAlreadyInProgressStderrPatterns.Matches(stderr) {
		return KindCherryPickAlreadyInProgress
	}
	if noOperationInProgressStderrPatterns.Matches(stderr) {
		return KindNoOperationInProgress
	}
	if unresolvedConflictsStderrPatterns.Matches(stderr) {
		return KindUnresolvedConflicts
	}
	if unrelatedHistoriesStderrPatterns.Matches(stderr) {
		return KindUnrelatedHistories
	}
	if noMergeBaseStderrPatterns.Matches(stderr) {
		return KindNoMergeBase
	}
	if emptyCommitStderrPatterns.Matches(stderr) {
		return KindEmptyCommit
	}
	if pathNotConflictedStderrPatterns.Matches(stderr) {
		return KindPathNotConflicted
	}
	if cloneDestinationInvalidStderrPatterns.Matches(stderr) {
		return KindCloneDestinationInvalid
	}
	if cloneDestinationNotWritableStderrPatterns.Matches(stderr) {
		return KindCloneDestinationNotWritable
	}
	if cloneDestinationExistsStderrPatterns.Matches(stderr) {
		return KindCloneDestinationExists
	}
	if cloneNameInvalidStderrPatterns.Matches(stderr) {
		return KindCloneNameInvalid
	}
	if cloneURLInvalidStderrPatterns.Matches(stderr) {
		return KindCloneUrlInvalid
	}
	if stashConflictStderrPatterns.Matches(stderr) {
		return KindStashConflict
	}
	if stashNotFoundStderrPatterns.Matches(stderr) {
		return KindStashNotFound
	}
	if forcePushRejectedStderrPatterns.Matches(stderr) {
		return KindForcePushRejected
	}
	if nonFastForwardStderrPatterns.Matches(stderr) {
		return KindNonFastForward
	}
	if protectedBranchStderrPatterns.Matches(stderr) {
		return KindProtectedBranch
	}
	if preReceiveHookRejectedStderrPatterns.Matches(stderr) {
		return KindPreReceiveHookRejected
	}
	if pushRejectedStderrPatterns.Matches(stderr) {
		return KindPushRejected
	}
	if branchNotFullyMergedStderrPatterns.Matches(stderr) {
		return KindBranchNotFullyMerged
	}
	if branchCheckedOutStderrPatterns.Matches(stderr) {
		return KindBranchCheckedOut
	}
	if branchNameInvalidStderrPatterns.Matches(stderr) {
		return KindBranchNameInvalid
	}
	if branchExistsStderrPatterns.Matches(stderr) {
		return KindBranchExists
	}
	if branchNotMergedStderrPatterns.Matches(stderr) {
		return KindBranchNotMerged
	}
	if remoteExistsStderrPatterns.Matches(stderr) {
		return KindRemoteExists
	}
	if remoteNameInvalidStderrPatterns.Matches(stderr) {
		return KindRemoteNameInvalid
	}
	if remoteURLInvalidStderrPatterns.Matches(stderr) {
		return KindRemoteUrlInvalid
	}
	if remoteNotFoundStderrPatterns.Matches(stderr) {
		return KindRemoteNotFound
	}
	if tagExistsStderrPatterns.Matches(stderr) {
		return KindTagExists
	}
	if tagNotFoundStderrPatterns.Matches(stderr) {
		return KindTagNotFound
	}
	if tagNameInvalidStderrPatterns.Matches(stderr) {
		return KindTagNameInvalid
	}
	if refNotFoundStderrPatterns.Matches(stderr) {
		return KindRefNotFound
	}
	if upstreamInvalidStderrPatterns.Matches(stderr) {
		return KindUpstreamInvalid
	}
	if emptyStashStderrPatterns.Matches(stderr) {
		return KindEmptyStash
	}
	if nothingToCommitStderrPatterns.Matches(stderr) {
		return KindNothingToCommit
	}
	if noLocalChangesStderrPatterns.Matches(stderr) {
		return KindNoLocalChanges
	}
	if noHeadStderrPatterns.Matches(stderr) {
		return KindNoHead
	}
	if noUpstreamStderrPatterns.Matches(stderr) {
		return KindNoUpstream
	}
	if noRemoteStderrPatterns.Matches(stderr) {
		return KindNoRemote
	}
	if conflictStderrPatterns.Matches(stderr) {
		return KindConflict
	}
	if notRepoStderrPatterns.Matches(stderr) {
		return KindNotRepo
	}
	if missingStderrPatterns.Matches(stderr) {
		return KindMissing
	}
	return KindUnknown
}

// HintForKind returns the stable recovery hint for a classified git failure.
func HintForKind(kind Kind) *ActionHint {
	switch kind {
	case KindNonFastForward:
		return &ActionHint{Kind: "pull-then-retry"}
	case KindForcePushRejected:
		return &ActionHint{Kind: "fetch-then-force"}
	case KindUnrelatedHistories:
		return &ActionHint{Kind: "allow-unrelated-histories"}
	case KindEmptyCommit:
		return &ActionHint{Kind: "allow-empty"}
	default:
		return nil
	}
}

// MessageForKind chooses a process-failure message while preserving stderr.
func MessageForKind(kind Kind, ctx MessageContext) string {
	trimmed := strings.TrimSpace(ctx.Stderr)
	if trimmed != "" {
		return trimmed
	}
	if kind == KindOutputTooLarge && ctx.LimitBytes > 0 {
		return fmt.Sprintf("Git output exceeded %s limit", formatBytes(ctx.LimitBytes))
	}
	if ctx.Signal != "" {
		return fmt.Sprintf("%s exited with signal %s", renderGitCommand(ctx.Args), ctx.Signal)
	}
	if ctx.ExitCode != nil {
		return fmt.Sprintf("%s exited with code %d", renderGitCommand(ctx.Args), *ctx.ExitCode)
	}
	switch kind {
	case KindAuth:
		return "Git authentication failed"
	case KindAuthRequired:
		return "Git authentication is required"
	case KindConflict:
		return "Git operation conflicted"
	case KindNotRepo:
		return "Not a Git repository"
	case KindMissing:
		return "Object or path not found in Git"
	case KindLockBusy:
		return "Another git process is holding the repository lock"
	case KindLocalChangesOverwritten:
		return "Local changes would be overwritten — commit or stash first"
	case KindNothingToCommit:
		return "Nothing to commit"
	case KindNoParent:
		return "HEAD has no parent commit"
	case KindSigningFailed:
		return "Git commit signing failed"
	case KindBinaryTooLarge:
		return "Binary file is too large"
	case KindFileNotInHead:
		return "File does not exist in HEAD"
	case KindPathNotInRepo:
		return "Path is not inside the repository"
	case KindGitignoreWriteFailed:
		return "Could not write .gitignore"
	case KindStashConflict:
		return "Stash apply conflicted"
	case KindStashNotFound:
		return "Stash entry not found"
	case KindCommitAborted:
		return "Commit was aborted"
	case KindBranchNotFullyMerged:
		return "Branch is not fully merged"
	case KindBranchCheckedOut:
		return "Branch is checked out in another worktree"
	case KindBranchNameInvalid:
		return "Branch name is invalid"
	case KindBranchExists:
		return "A branch with that name already exists"
	case KindRemoteExists:
		return "A remote with that name already exists"
	case KindRemoteNameInvalid:
		return "Remote name is invalid"
	case KindRemoteUrlInvalid:
		return "Remote URL is invalid"
	case KindRemoteNotFound:
		return "Remote not found"
	case KindTagExists:
		return "A tag with that name already exists"
	case KindTagNotFound:
		return "Tag not found"
	case KindTagNameInvalid:
		return "Tag name is invalid"
	case KindRefNotFound:
		return "Reference not found"
	case KindUpstreamInvalid:
		return "Upstream is invalid"
	case KindMergeAlreadyInProgress:
		return "A merge is already in progress"
	case KindRebaseAlreadyInProgress:
		return "A rebase is already in progress"
	case KindCherryPickAlreadyInProgress:
		return "A cherry-pick is already in progress"
	case KindNoOperationInProgress:
		return "No Git operation is in progress"
	case KindUnresolvedConflicts:
		return "Resolve conflicts before continuing"
	case KindUnrelatedHistories:
		return "Git histories are unrelated"
	case KindNoMergeBase:
		return "No merge base found"
	case KindEmptyCommit:
		return "Operation produced an empty commit"
	case KindPathNotConflicted:
		return "Path is not conflicted"
	case KindCloneDestinationInvalid:
		return "Clone destination is invalid"
	case KindCloneDestinationNotWritable:
		return "Clone destination is not writable"
	case KindCloneDestinationExists:
		return "Clone destination already exists"
	case KindCloneNameInvalid:
		return "Clone folder name is invalid"
	case KindCloneUrlInvalid:
		return "Clone URL is invalid"
	case KindNonFastForward:
		return "Push rejected — pull first"
	case KindProtectedBranch:
		return "Push rejected by protected branch policy"
	case KindPreReceiveHookRejected:
		return "Push rejected by pre-receive hook"
	case KindPushRejected:
		return "Push rejected — fetch and merge first"
	case KindForcePushRejected:
		return "Force push rejected — fetch first to refresh your local view"
	case KindNoLocalChanges:
		return "No changes to record"
	case KindBranchNotMerged:
		return "Branch is not fully merged"
	case KindNoHead:
		return "Repository has no commits yet"
	case KindNoUpstream:
		return "Current branch has no upstream"
	case KindNoRemote:
		return "No git remote configured"
	case KindNoSuchRef:
		return "Reference not found"
	case KindEmptyStash:
		return "Stash is empty"
	case KindDirtyTree:
		return "Working tree has uncommitted changes"
	case KindGitMissing:
		return "Git executable not found"
	case KindOutputTooLarge:
		return "Git output exceeded the configured limit"
	default:
		return fmt.Sprintf("%s failed", renderGitCommand(ctx.Args))
	}
}

// renderGitCommand formats a compact command label without environment values.
func renderGitCommand(args []string) string {
	return strings.Join(append([]string{"git"}, args...), " ")
}

// formatBytes converts a byte count to the same small MB label used by TS.
func formatBytes(bytes int64) string {
	mib := float64(bytes) / (1024 * 1024)
	if mib == float64(int64(mib)) {
		return strconv.FormatInt(int64(mib), 10) + " MB"
	}
	return fmt.Sprintf("%.1f MB", mib)
}
