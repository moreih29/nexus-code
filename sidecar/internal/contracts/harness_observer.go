package contracts

// 수작업 유지 — schema 변경 시 수동 동기화 필요. drift 검증은
// .github/workflows/contracts-drift.yml의 Go diff 단계에 위임한다.

type TabBadgeState string

const (
	TabBadgeStateRunning          TabBadgeState = "running"
	TabBadgeStateAwaitingApproval TabBadgeState = "awaiting-approval"
	TabBadgeStateCompleted        TabBadgeState = "completed"
	TabBadgeStateError            TabBadgeState = "error"
)

type TabBadgeEvent struct {
	Type        string        `json:"type"`
	State       TabBadgeState `json:"state"`
	SessionID   string        `json:"sessionId"`
	AdapterName string        `json:"adapterName"`
	WorkspaceID WorkspaceID   `json:"workspaceId"`
	Timestamp   string        `json:"timestamp"`
}
