package contracts

// 수작업 유지 — schema/lsp-*.schema.json 변경 시 수동 동기화 필요.
// drift 검증은 scripts/check-go-contracts-drift.sh의 Go diff 단계가 담당한다.

type LspLanguage string

const (
	LspLanguageTypescript LspLanguage = "typescript"
	LspLanguagePython     LspLanguage = "python"
	LspLanguageGo         LspLanguage = "go"
)

type LspLifecycleAction string

const (
	LspLifecycleActionStartServer       LspLifecycleAction = "start_server"
	LspLifecycleActionStopServer        LspLifecycleAction = "stop_server"
	LspLifecycleActionRestartServer     LspLifecycleAction = "restart_server"
	LspLifecycleActionHealthCheck       LspLifecycleAction = "health_check"
	LspLifecycleActionStopAll           LspLifecycleAction = "stop_all"
	LspLifecycleActionServerStarted     LspLifecycleAction = "server_started"
	LspLifecycleActionServerStartFailed LspLifecycleAction = "server_start_failed"
	LspLifecycleActionServerStopped     LspLifecycleAction = "server_stopped"
	LspLifecycleActionServerHealth      LspLifecycleAction = "server_health"
	LspLifecycleActionStopAllStopped    LspLifecycleAction = "stop_all_stopped"
)

type LspServerStopReason string

const (
	LspServerStopReasonDocumentClose  LspServerStopReason = "document-close"
	LspServerStopReasonWorkspaceClose LspServerStopReason = "workspace-close"
	LspServerStopReasonAppShutdown    LspServerStopReason = "app-shutdown"
	LspServerStopReasonRestart        LspServerStopReason = "restart"
	LspServerStopReasonSidecarStop    LspServerStopReason = "sidecar-stop"
)

type LspServerState string

const (
	LspServerStateRunning     LspServerState = "running"
	LspServerStateStopped     LspServerState = "stopped"
	LspServerStateUnavailable LspServerState = "unavailable"
	LspServerStateError       LspServerState = "error"
)

type LspRelayDirection string

const (
	LspRelayDirectionClientToServer LspRelayDirection = "client_to_server"
	LspRelayDirectionServerToClient LspRelayDirection = "server_to_client"
)

type LspStartServerCommand struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
	Language    LspLanguage        `json:"language"`
	Command     string             `json:"command"`
	Args        []string           `json:"args"`
	Cwd         string             `json:"cwd"`
	ServerName  string             `json:"serverName"`
}

type LspStopServerCommand struct {
	Type        string              `json:"type"`
	Action      LspLifecycleAction  `json:"action"`
	RequestID   string              `json:"requestId"`
	WorkspaceID WorkspaceID         `json:"workspaceId"`
	ServerID    string              `json:"serverId"`
	Language    LspLanguage         `json:"language"`
	ServerName  string              `json:"serverName"`
	Reason      LspServerStopReason `json:"reason"`
}

type LspRestartServerCommand struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
	Language    LspLanguage        `json:"language"`
	Command     string             `json:"command"`
	Args        []string           `json:"args"`
	Cwd         string             `json:"cwd"`
	ServerName  string             `json:"serverName"`
}

type LspHealthCheckCommand struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
}

type LspStopAllServersCommand struct {
	Type        string              `json:"type"`
	Action      LspLifecycleAction  `json:"action"`
	RequestID   string              `json:"requestId"`
	WorkspaceID *WorkspaceID        `json:"workspaceId,omitempty"`
	Reason      LspServerStopReason `json:"reason"`
}

type LspServerStartedReply struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
	Language    LspLanguage        `json:"language"`
	ServerName  string             `json:"serverName"`
	PID         int                `json:"pid"`
}

type LspServerStartFailedReply struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
	Language    LspLanguage        `json:"language"`
	ServerName  string             `json:"serverName"`
	State       LspServerState     `json:"state"`
	Message     string             `json:"message"`
}

type LspServerStoppedEvent struct {
	Type        string              `json:"type"`
	Action      LspLifecycleAction  `json:"action"`
	RequestID   string              `json:"requestId,omitempty"`
	WorkspaceID WorkspaceID         `json:"workspaceId"`
	ServerID    string              `json:"serverId"`
	Language    LspLanguage         `json:"language"`
	ServerName  string              `json:"serverName"`
	Reason      LspServerStopReason `json:"reason"`
	ExitCode    *int                `json:"exitCode"`
	Signal      *string             `json:"signal"`
	StoppedAt   string              `json:"stoppedAt"`
	Message     string              `json:"message,omitempty"`
}

type LspServerHealthReply struct {
	Type        string             `json:"type"`
	Action      LspLifecycleAction `json:"action"`
	RequestID   string             `json:"requestId"`
	WorkspaceID WorkspaceID        `json:"workspaceId"`
	ServerID    string             `json:"serverId"`
	State       LspServerState     `json:"state"`
	PID         int                `json:"pid,omitempty"`
	Message     string             `json:"message,omitempty"`
}

type LspStopAllServersReply struct {
	Type             string             `json:"type"`
	Action           LspLifecycleAction `json:"action"`
	RequestID        string             `json:"requestId"`
	WorkspaceID      *WorkspaceID       `json:"workspaceId,omitempty"`
	StoppedServerIDs []string           `json:"stoppedServerIds"`
}

type LspClientPayloadMessage struct {
	Type        string            `json:"type"`
	Direction   LspRelayDirection `json:"direction"`
	WorkspaceID WorkspaceID       `json:"workspaceId"`
	ServerID    string            `json:"serverId"`
	Seq         int               `json:"seq"`
	Payload     string            `json:"payload"`
}

type LspServerPayloadMessage struct {
	Type        string            `json:"type"`
	Direction   LspRelayDirection `json:"direction"`
	WorkspaceID WorkspaceID       `json:"workspaceId"`
	ServerID    string            `json:"serverId"`
	Seq         int               `json:"seq"`
	Payload     string            `json:"payload"`
}
