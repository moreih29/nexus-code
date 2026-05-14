package lsp

import (
	"encoding/json"
	"time"
)

const (
	EventMessage       = "lsp.message"
	EventServerRequest = "lsp.serverRequest"

	defaultIdleTimeout     = 30 * time.Minute
	initializeTimeout      = 5 * time.Second
	shutdownRequestTimeout = 750 * time.Millisecond
	shutdownExitGrace      = 750 * time.Millisecond
)

// EventSink is the callback lsp uses to push server messages back to Electron.
type EventSink func(event string, payload any) error

type SpawnParams struct {
	WorkspaceID   string   `json:"workspaceId"`
	LanguageID    string   `json:"languageId"`
	BinaryPath    string   `json:"binaryPath"`
	Args          []string `json:"args"`
	WorkspaceRoot string   `json:"workspaceRoot"`
	IdleTimeoutMs *int     `json:"idleTimeoutMs,omitempty"`
}

type SpawnResult struct {
	ServerID     string          `json:"serverId"`
	Capabilities json.RawMessage `json:"capabilities"`
}

type SendParams struct {
	ServerID string          `json:"serverId"`
	Message  json.RawMessage `json:"message"`
}

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
