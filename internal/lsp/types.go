package lsp

import (
	"encoding/json"
	"time"
)

const (
	EventMessage        = "lsp.message"
	EventServerRequest  = "lsp.serverRequest"
	EventServerAssigned = "lsp.serverAssigned"
	EventServerExited   = "lsp.serverExited"

	defaultIdleTimeout     = 30 * time.Minute
	initializeTimeout      = 5 * time.Second
	stdinWriteTimeout      = 2 * time.Second
	shutdownRequestTimeout = 750 * time.Millisecond
	shutdownExitGrace      = 750 * time.Millisecond

	outputDrainGrace = 500 * time.Millisecond

	stderrTailBytes = 8 * 1024
)

type EventSink func(event string, payload any) error

type SpawnParams struct {
	WorkspaceID   string   `json:"workspaceId"`
	LanguageID    string   `json:"languageId"`
	BinaryPath    string   `json:"binaryPath"`
	Args          []string `json:"args"`
	WorkspaceRoot string   `json:"workspaceRoot"`
	IdleTimeoutMs *int     `json:"idleTimeoutMs,omitempty"`

	CorrelationID string `json:"correlationId,omitempty"`

	Capabilities json.RawMessage `json:"capabilities,omitempty"`

	InitializationOptions json.RawMessage `json:"initializationOptions,omitempty"`

	Env map[string]string `json:"env,omitempty"`
}

type SpawnResult struct {
	ServerID     string          `json:"serverId"`
	Capabilities json.RawMessage `json:"capabilities"`
	ServerInfo   *ServerInfo     `json:"serverInfo,omitempty"`
}

type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

type StatsResult struct {
	Servers []ServerStats `json:"servers"`
}

type ServerStats struct {
	ServerID string `json:"serverId"`
	RSSBytes uint64 `json:"rssBytes"`
}

type SendParams struct {
	ServerID string          `json:"serverId"`
	Message  json.RawMessage `json:"message"`
}

type NotifyParams = SendParams

type CancelParams struct {
	ServerID  string          `json:"serverId"`
	RequestID json.RawMessage `json:"requestId"`
}

type ShutdownParams struct {
	ServerID string `json:"serverId"`
}

type RespondServerRequestParams struct {
	ServerID       string          `json:"serverId"`
	AgentRequestID string          `json:"agentRequestId"`
	Result         json.RawMessage `json:"result,omitempty"`
	Error          json.RawMessage `json:"error,omitempty"`
}

type MessagePayload struct {
	ServerID string          `json:"serverId"`
	Message  json.RawMessage `json:"message"`
}

type ServerRequestPayload struct {
	ServerID       string          `json:"serverId"`
	AgentRequestID string          `json:"agentRequestId"`
	Method         string          `json:"method"`
	Params         json.RawMessage `json:"params,omitempty"`
}

type ServerAssignedPayload struct {
	ServerID      string `json:"serverId"`
	CorrelationID string `json:"correlationId,omitempty"`
}

type ServerExitedPayload struct {
	ServerID   string `json:"serverId"`
	Reason     string `json:"reason,omitempty"`
	StderrTail string `json:"stderrTail,omitempty"`
	Shutdown   bool   `json:"shutdown,omitempty"`
}

type jsonRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rawRequestIDResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}
