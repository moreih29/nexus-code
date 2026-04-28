package contracts

// 수작업 유지 — schema/search-*.schema.json 변경 시 수동 동기화 필요.
// drift 검증은 scripts/check-go-contracts-drift.sh의 Go diff 단계가 담당한다.

type SearchLifecycleAction string

const (
	SearchLifecycleActionStart     SearchLifecycleAction = "start"
	SearchLifecycleActionCancel    SearchLifecycleAction = "cancel"
	SearchLifecycleActionStarted   SearchLifecycleAction = "started"
	SearchLifecycleActionCompleted SearchLifecycleAction = "completed"
	SearchLifecycleActionFailed    SearchLifecycleAction = "failed"
	SearchLifecycleActionCanceled  SearchLifecycleAction = "canceled"
)

type SearchFailureState string

const (
	SearchFailureStateUnavailable SearchFailureState = "unavailable"
	SearchFailureStateError       SearchFailureState = "error"
)

type SearchRelayKind string

const (
	SearchRelayKindResultChunk SearchRelayKind = "result_chunk"
)

type SearchRelayDirection string

const (
	SearchRelayDirectionServerToClient SearchRelayDirection = "server_to_client"
)

type SearchOptions struct {
	CaseSensitive bool     `json:"caseSensitive"`
	Regex         bool     `json:"regex"`
	WholeWord     bool     `json:"wholeWord"`
	IncludeGlobs  []string `json:"includeGlobs"`
	ExcludeGlobs  []string `json:"excludeGlobs"`
	UseGitIgnore  *bool    `json:"useGitIgnore,omitempty"`
}

type SearchStartCommand struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
	Query       string                `json:"query"`
	Cwd         string                `json:"cwd"`
	Options     SearchOptions         `json:"options"`
}

type SearchCancelCommand struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
}

type SearchStartedReply struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
	RipgrepPath string                `json:"ripgrepPath"`
	StartedAt   string                `json:"startedAt"`
}

type SearchCompletedEvent struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
	MatchCount  int                   `json:"matchCount"`
	FileCount   int                   `json:"fileCount"`
	Truncated   bool                  `json:"truncated"`
	ExitCode    *int                  `json:"exitCode"`
	CompletedAt string                `json:"completedAt"`
}

type SearchFailedEvent struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
	State       SearchFailureState    `json:"state"`
	Message     string                `json:"message"`
	ExitCode    *int                  `json:"exitCode"`
	FailedAt    string                `json:"failedAt"`
}

type SearchCanceledEvent struct {
	Type        string                `json:"type"`
	Action      SearchLifecycleAction `json:"action"`
	RequestID   string                `json:"requestId,omitempty"`
	WorkspaceID WorkspaceID           `json:"workspaceId"`
	SessionID   string                `json:"sessionId"`
	MatchCount  int                   `json:"matchCount"`
	FileCount   int                   `json:"fileCount"`
	Truncated   bool                  `json:"truncated"`
	CanceledAt  string                `json:"canceledAt"`
	Message     string                `json:"message,omitempty"`
}

type SearchSubmatch struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Match string `json:"match"`
}

type SearchResult struct {
	Path       string           `json:"path"`
	LineNumber int              `json:"lineNumber"`
	Column     int              `json:"column"`
	LineText   string           `json:"lineText"`
	Submatches []SearchSubmatch `json:"submatches"`
}

type SearchResultChunkMessage struct {
	Type        string               `json:"type"`
	Direction   SearchRelayDirection `json:"direction"`
	Kind        SearchRelayKind      `json:"kind"`
	WorkspaceID WorkspaceID          `json:"workspaceId"`
	SessionID   string               `json:"sessionId"`
	Seq         int                  `json:"seq"`
	Results     []SearchResult       `json:"results"`
	Truncated   bool                 `json:"truncated"`
}
