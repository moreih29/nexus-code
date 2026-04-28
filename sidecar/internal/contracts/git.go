package contracts

// 수작업 유지 — schema/git-*.schema.json 변경 시 수동 동기화 필요.
// drift 검증은 scripts/check-go-contracts-drift.sh의 Go diff 단계가 담당한다.

type GitLifecycleAction string

const (
	GitLifecycleActionStatus             GitLifecycleAction = "status"
	GitLifecycleActionBranchList         GitLifecycleAction = "branch_list"
	GitLifecycleActionCommit             GitLifecycleAction = "commit"
	GitLifecycleActionStage              GitLifecycleAction = "stage"
	GitLifecycleActionUnstage            GitLifecycleAction = "unstage"
	GitLifecycleActionDiscard            GitLifecycleAction = "discard"
	GitLifecycleActionCheckout           GitLifecycleAction = "checkout"
	GitLifecycleActionBranchCreate       GitLifecycleAction = "branch_create"
	GitLifecycleActionBranchDelete       GitLifecycleAction = "branch_delete"
	GitLifecycleActionDiff               GitLifecycleAction = "diff"
	GitLifecycleActionWatchStart         GitLifecycleAction = "watch_start"
	GitLifecycleActionWatchStop          GitLifecycleAction = "watch_stop"
	GitLifecycleActionStatusResult       GitLifecycleAction = "status_result"
	GitLifecycleActionBranchListResult   GitLifecycleAction = "branch_list_result"
	GitLifecycleActionCommitResult       GitLifecycleAction = "commit_result"
	GitLifecycleActionStageResult        GitLifecycleAction = "stage_result"
	GitLifecycleActionUnstageResult      GitLifecycleAction = "unstage_result"
	GitLifecycleActionDiscardResult      GitLifecycleAction = "discard_result"
	GitLifecycleActionCheckoutResult     GitLifecycleAction = "checkout_result"
	GitLifecycleActionBranchCreateResult GitLifecycleAction = "branch_create_result"
	GitLifecycleActionBranchDeleteResult GitLifecycleAction = "branch_delete_result"
	GitLifecycleActionDiffResult         GitLifecycleAction = "diff_result"
	GitLifecycleActionWatchStarted       GitLifecycleAction = "watch_started"
	GitLifecycleActionWatchStopped       GitLifecycleAction = "watch_stopped"
	GitLifecycleActionFailed             GitLifecycleAction = "failed"
)

type GitFailureState string

const (
	GitFailureStateUnavailable GitFailureState = "unavailable"
	GitFailureStateError       GitFailureState = "error"
)

type GitFileStatusKind string

const (
	GitFileStatusKindModified   GitFileStatusKind = "modified"
	GitFileStatusKindAdded      GitFileStatusKind = "added"
	GitFileStatusKindDeleted    GitFileStatusKind = "deleted"
	GitFileStatusKindRenamed    GitFileStatusKind = "renamed"
	GitFileStatusKindCopied     GitFileStatusKind = "copied"
	GitFileStatusKindUntracked  GitFileStatusKind = "untracked"
	GitFileStatusKindIgnored    GitFileStatusKind = "ignored"
	GitFileStatusKindConflicted GitFileStatusKind = "conflicted"
	GitFileStatusKindClean      GitFileStatusKind = "clean"
)

type GitRelayKind string

const (
	GitRelayKindStatusChange GitRelayKind = "status_change"
)

type GitStatusEntry struct {
	Path           string            `json:"path"`
	OriginalPath   *string           `json:"originalPath"`
	Status         string            `json:"status"`
	IndexStatus    string            `json:"indexStatus"`
	WorkTreeStatus string            `json:"workTreeStatus"`
	Kind           GitFileStatusKind `json:"kind"`
}

type GitStatusSummary struct {
	Branch   *string          `json:"branch"`
	Upstream *string          `json:"upstream"`
	Ahead    int              `json:"ahead"`
	Behind   int              `json:"behind"`
	Files    []GitStatusEntry `json:"files"`
}

type GitBranch struct {
	Name     string  `json:"name"`
	Current  bool    `json:"current"`
	Upstream *string `json:"upstream"`
	HeadOid  *string `json:"headOid"`
}

type GitStatusCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
}

type GitBranchListCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
}

type GitCommitCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Message     string             `json:"message"`
	Amend       bool               `json:"amend,omitempty"`
}

type GitStageCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Paths       []string           `json:"paths"`
}

type GitUnstageCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Paths       []string           `json:"paths"`
}

type GitDiscardCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Paths       []string           `json:"paths"`
}

type GitCheckoutCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Ref         string             `json:"ref"`
}

type GitBranchCreateCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Name        string             `json:"name"`
	StartPoint  *string            `json:"startPoint,omitempty"`
}

type GitBranchDeleteCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Name        string             `json:"name"`
	Force       bool               `json:"force"`
}

type GitDiffCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Staged      bool               `json:"staged"`
	Paths       []string           `json:"paths"`
}

type GitWatchStartCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	WatchID     string             `json:"watchId"`
	DebounceMs  *int               `json:"debounceMs,omitempty"`
}

type GitWatchStopCommand struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	WatchID     string             `json:"watchId"`
}

type GitStatusReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Summary     GitStatusSummary   `json:"summary"`
	GeneratedAt string             `json:"generatedAt"`
}

type GitBranchListReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Branches    []GitBranch        `json:"branches"`
	GeneratedAt string             `json:"generatedAt"`
}

type GitCommitReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	CommitOid   string             `json:"commitOid"`
	Summary     GitStatusSummary   `json:"summary"`
	CompletedAt string             `json:"completedAt"`
}

type GitStageReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Summary     GitStatusSummary   `json:"summary"`
	CompletedAt string             `json:"completedAt"`
}

type GitUnstageReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Summary     GitStatusSummary   `json:"summary"`
	CompletedAt string             `json:"completedAt"`
}

type GitDiscardReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Summary     GitStatusSummary   `json:"summary"`
	CompletedAt string             `json:"completedAt"`
}

type GitCheckoutReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Summary     GitStatusSummary   `json:"summary"`
	CompletedAt string             `json:"completedAt"`
}

type GitBranchCreateReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Branches    []GitBranch        `json:"branches"`
	CompletedAt string             `json:"completedAt"`
}

type GitBranchDeleteReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Branches    []GitBranch        `json:"branches"`
	CompletedAt string             `json:"completedAt"`
}

type GitDiffReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	Cwd         string             `json:"cwd"`
	Staged      bool               `json:"staged"`
	Paths       []string           `json:"paths"`
	Diff        string             `json:"diff"`
	GeneratedAt string             `json:"generatedAt"`
}

type GitWatchStartedReply struct {
	Type         string             `json:"type"`
	Action       GitLifecycleAction `json:"action"`
	RequestID    string             `json:"requestId"`
	WorkspaceID  WorkspaceID        `json:"workspaceId"`
	Cwd          string             `json:"cwd"`
	WatchID      string             `json:"watchId"`
	WatchedPaths []string           `json:"watchedPaths"`
	StartedAt    string             `json:"startedAt"`
}

type GitWatchStoppedReply struct {
	Type        string             `json:"type"`
	Action      GitLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	WatchID     string             `json:"watchId"`
	StoppedAt   string             `json:"stoppedAt"`
}

type GitFailedEvent struct {
	Type         string             `json:"type"`
	Action       GitLifecycleAction `json:"action"`
	FailedAction GitLifecycleAction `json:"failedAction"`
	RequestID    string             `json:"requestId"`
	WorkspaceID  WorkspaceID        `json:"workspaceId"`
	Cwd          string             `json:"cwd"`
	State        GitFailureState    `json:"state"`
	Message      string             `json:"message"`
	ExitCode     *int               `json:"exitCode"`
	Stderr       string             `json:"stderr"`
	FailedAt     string             `json:"failedAt"`
}

type GitStatusChangeEvent struct {
	Type        string           `json:"type"`
	Kind        GitRelayKind     `json:"kind"`
	WorkspaceID WorkspaceID      `json:"workspaceId"`
	WatchID     string           `json:"watchId"`
	Cwd         string           `json:"cwd"`
	Seq         int              `json:"seq"`
	Summary     GitStatusSummary `json:"summary"`
	ChangedAt   string           `json:"changedAt"`
}
