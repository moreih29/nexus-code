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
	shutdownRequestTimeout = 750 * time.Millisecond
	shutdownExitGrace      = 750 * time.Millisecond

	// stderrTailBytes caps the in-memory stderr ring buffer per server.
	// 8 KB is enough to capture a typical Node/Python panic trace without
	// growing unbounded for chatty servers.
	stderrTailBytes = 8 * 1024
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

	// CorrelationID is opaque to the agent. The TS client supplies it so
	// pre-spawn-resolution events (server-pushed messages emitted while
	// initialize is still in flight) can be attributed to the requesting
	// workspace+language pair before serverId is known.
	CorrelationID string `json:"correlationId,omitempty"`
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

// ServerAssignedPayload is emitted exactly once per spawn, immediately after
// the agent assigns a serverId and before initialize runs. Clients use it to
// bind serverId↔correlationId so they can route messages that arrive while
// the spawn call is still in flight.
type ServerAssignedPayload struct {
	ServerID      string `json:"serverId"`
	CorrelationID string `json:"correlationId,omitempty"`
}

// ServerExitedPayload is emitted when an LSP server process terminates
// (clean shutdown, crash, or kill). Reason is best-effort human text; the
// stderrTail field carries the last few KB of stderr to help diagnosis.
type ServerExitedPayload struct {
	ServerID   string `json:"serverId"`
	Reason     string `json:"reason,omitempty"`
	StderrTail string `json:"stderrTail,omitempty"`
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
