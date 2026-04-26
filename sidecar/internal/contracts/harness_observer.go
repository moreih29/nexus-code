package contracts

// 수작업 유지 — schema 변경 시 수동 동기화 필요. drift 검증은
// .github/workflows/contracts-drift.yml의 Go diff 단계에 위임한다.

type TabBadgeState string
type ToolCallStatus string

const (
	TabBadgeStateRunning          TabBadgeState = "running"
	TabBadgeStateAwaitingApproval TabBadgeState = "awaiting-approval"
	TabBadgeStateCompleted        TabBadgeState = "completed"
	TabBadgeStateError            TabBadgeState = "error"

	ToolCallStatusStarted          ToolCallStatus = "started"
	ToolCallStatusCompleted        ToolCallStatus = "completed"
	ToolCallStatusAwaitingApproval ToolCallStatus = "awaiting-approval"
	ToolCallStatusError            ToolCallStatus = "error"
)

type TabBadgeEvent struct {
	Type        string        `json:"type"`
	State       TabBadgeState `json:"state"`
	SessionID   string        `json:"sessionId"`
	AdapterName string        `json:"adapterName"`
	WorkspaceID WorkspaceID   `json:"workspaceId"`
	Timestamp   string        `json:"timestamp"`
}

type ToolCallEvent struct {
	Type          string         `json:"type"`
	Status        ToolCallStatus `json:"status"`
	ToolName      string         `json:"toolName"`
	SessionID     string         `json:"sessionId"`
	AdapterName   string         `json:"adapterName"`
	WorkspaceID   WorkspaceID    `json:"workspaceId"`
	Timestamp     string         `json:"timestamp"`
	ToolCallID    string         `json:"toolCallId,omitempty"`
	InputSummary  string         `json:"inputSummary,omitempty"`
	ResultSummary string         `json:"resultSummary,omitempty"`
	Message       string         `json:"message,omitempty"`
}

type SessionHistoryEvent struct {
	Type           string      `json:"type"`
	SessionID      string      `json:"sessionId"`
	AdapterName    string      `json:"adapterName"`
	WorkspaceID    WorkspaceID `json:"workspaceId"`
	Timestamp      string      `json:"timestamp"`
	TranscriptPath string      `json:"transcriptPath"`
}
