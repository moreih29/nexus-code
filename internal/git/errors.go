package git

import "github.com/nexus-code/nexus-code/internal/proto"

// Kind is the Go mirror of src/shared/types/git.ts GitErrorKindSchema.
type Kind string

const (
	KindAuth                        Kind = "auth"
	KindAuthRequired                Kind = "auth-required"
	KindConflict                    Kind = "conflict"
	KindNotRepo                     Kind = "not-repo"
	KindMissing                     Kind = "missing"
	KindOutputTooLarge              Kind = "output-too-large"
	KindGitMissing                  Kind = "git-missing"
	KindNoHead                      Kind = "no-head"
	KindNoUpstream                  Kind = "no-upstream"
	KindNoRemote                    Kind = "no-remote"
	KindNoSuchRef                   Kind = "no-such-ref"
	KindEmptyStash                  Kind = "empty-stash"
	KindDirtyTree                   Kind = "dirty-tree"
	KindLockBusy                    Kind = "lock-busy"
	KindLocalChangesOverwritten     Kind = "local-changes-overwritten"
	KindNothingToCommit             Kind = "nothing-to-commit"
	KindNoParent                    Kind = "no-parent"
	KindSigningFailed               Kind = "signing-failed"
	KindBinaryTooLarge              Kind = "binary-too-large"
	KindFileNotInHead               Kind = "file-not-in-head"
	KindPathNotInRepo               Kind = "path-not-in-repo"
	KindGitignoreWriteFailed        Kind = "gitignore-write-failed"
	KindStashConflict               Kind = "stash-conflict"
	KindStashNotFound               Kind = "stash-not-found"
	KindCommitAborted               Kind = "commit-aborted"
	KindBranchNotFullyMerged        Kind = "branch-not-fully-merged"
	KindBranchCheckedOut            Kind = "branch-checked-out"
	KindBranchNameInvalid           Kind = "branch-name-invalid"
	KindBranchExists                Kind = "branch-exists"
	KindRemoteExists                Kind = "remote-exists"
	KindRemoteNameInvalid           Kind = "remote-name-invalid"
	KindRemoteUrlInvalid            Kind = "remote-url-invalid"
	KindRemoteNotFound              Kind = "remote-not-found"
	KindTagExists                   Kind = "tag-exists"
	KindTagNotFound                 Kind = "tag-not-found"
	KindTagNameInvalid              Kind = "tag-name-invalid"
	KindRefNotFound                 Kind = "ref-not-found"
	KindUpstreamInvalid             Kind = "upstream-invalid"
	KindMergeAlreadyInProgress      Kind = "merge-already-in-progress"
	KindRebaseAlreadyInProgress     Kind = "rebase-already-in-progress"
	KindCherryPickAlreadyInProgress Kind = "cherry-pick-already-in-progress"
	KindNoOperationInProgress       Kind = "no-operation-in-progress"
	KindUnresolvedConflicts         Kind = "unresolved-conflicts"
	KindUnrelatedHistories          Kind = "unrelated-histories"
	KindNoMergeBase                 Kind = "no-merge-base"
	KindEmptyCommit                 Kind = "empty-commit"
	KindPathNotConflicted           Kind = "path-not-conflicted"
	KindCloneDestinationInvalid     Kind = "clone-destination-invalid"
	KindCloneDestinationNotWritable Kind = "clone-destination-not-writable"
	KindCloneDestinationExists      Kind = "clone-destination-exists"
	KindCloneNameInvalid            Kind = "clone-name-invalid"
	KindCloneUrlInvalid             Kind = "clone-url-invalid"
	KindNonFastForward              Kind = "non-fast-forward"
	KindProtectedBranch             Kind = "protected-branch"
	KindPreReceiveHookRejected      Kind = "pre-receive-hook-rejected"
	KindPushRejected                Kind = "push-rejected"
	KindForcePushRejected           Kind = "force-push-rejected"
	KindNoLocalChanges              Kind = "no-local-changes"
	KindBranchNotMerged             Kind = "branch-not-merged"
	KindUnknown                     Kind = "unknown"
)

// ActionHint is the JSON-friendly Go mirror of GitActionHintSchema. Only fields
// used by the selected hint kind are populated.
type ActionHint struct {
	Kind            string   `json:"kind"`
	Branch          string   `json:"branch,omitempty"`
	SuggestedRemote string   `json:"suggestedRemote,omitempty"`
	RemoteRef       string   `json:"remoteRef,omitempty"`
	Candidates      []string `json:"candidates,omitempty"`
}

// Failure is a git command that exited non-zero, classified from its stderr.
// Dedicated methods (push, pull, tag, stash, ...) return it so the host can
// rebuild its typed git error; git.run reports the same fields in its result
// instead.
type Failure struct {
	Kind Kind
	Msg  string
	Hint *ActionHint
}

func (f Failure) Error() string     { return f.Msg }
func (f Failure) ErrorCode() string { return proto.CodeRequestFailed }
func (f Failure) ErrorData() any {
	return failureData{ErrorKind: f.Kind, ErrorHint: f.Hint}
}

// failureData is the wire shape of Failure in an error frame's data, named
// after the matching git.run result fields.
type failureData struct {
	ErrorKind Kind        `json:"errorKind"`
	ErrorHint *ActionHint `json:"errorHint,omitempty"`
}

// classifiedFailure builds the Failure for a git exit already classified as
// kind, with kind's recovery hint.
func classifiedFailure(kind Kind, msg string) error {
	return Failure{Kind: kind, Msg: msg, Hint: HintForKind(kind)}
}

// ClassifiedError is the external Go surface for git stderr classification.
type ClassifiedError struct {
	Kind    Kind        `json:"kind"`
	Message string      `json:"message"`
	Hint    *ActionHint `json:"hint,omitempty"`
	Argv    []string    `json:"argv,omitempty"`
}
