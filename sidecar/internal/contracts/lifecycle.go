package contracts

// 수작업 유지 — schema 변경 시 수동 동기화 필요. drift 검증은
// .github/workflows/contracts-drift.yml의 Go diff 단계에 위임한다.
// 향후 harness-* schema 도입 시 또는 Go codegen 도구 성숙 시 facade 패턴 도입을 재검토한다.

type WorkspaceID string

type SidecarStartReason string

const (
	SidecarStartReasonWorkspaceOpen  SidecarStartReason = "workspace-open"
	SidecarStartReasonSessionRestore SidecarStartReason = "session-restore"
)

type SidecarStopReason string

const (
	SidecarStopReasonWorkspaceClose SidecarStopReason = "workspace-close"
	SidecarStopReasonAppShutdown    SidecarStopReason = "app-shutdown"
)

type SidecarStoppedReason string

const (
	SidecarStoppedReasonRequested    SidecarStoppedReason = "requested"
	SidecarStoppedReasonProcessExit  SidecarStoppedReason = "process-exit"
	SidecarStoppedReasonProcessCrash SidecarStoppedReason = "process-crash"
)

type SidecarStartCommand struct {
	Type          string             `json:"type"`
	WorkspaceID   WorkspaceID        `json:"workspaceId"`
	WorkspacePath string             `json:"workspacePath"`
	Reason        SidecarStartReason `json:"reason"`
}

type SidecarStartedEvent struct {
	Type        string      `json:"type"`
	WorkspaceID WorkspaceID `json:"workspaceId"`
	PID         int         `json:"pid"`
	StartedAt   string      `json:"startedAt"`
}

type SidecarStopCommand struct {
	Type        string            `json:"type"`
	WorkspaceID WorkspaceID       `json:"workspaceId"`
	Reason      SidecarStopReason `json:"reason"`
}

type SidecarStoppedEvent struct {
	Type        string               `json:"type"`
	WorkspaceID WorkspaceID          `json:"workspaceId"`
	Reason      SidecarStoppedReason `json:"reason"`
	StoppedAt   string               `json:"stoppedAt"`
	ExitCode    *int                 `json:"exitCode"`
}
