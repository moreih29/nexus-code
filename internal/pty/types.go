package pty

import "time"

const (
	EventData = "pty.data"
	EventExit = "pty.exit"

	HighWatermarkBytes = 100_000
	LowWatermarkBytes  = 5_000
	MaxChunkSize       = 4 * 1024
	maxWriteChunkSize  = 1024
	exitDrainGrace     = 150 * time.Millisecond

	RingCapBytes = 1 * 1024 * 1024

	terminalReset = "\x1bc"
)

type EventSink func(event string, payload any) error

type SpawnParams struct {
	WorkspaceID string            `json:"workspaceId"`
	TabID       string            `json:"tabId"`
	Cwd         string            `json:"cwd"`
	Shell       string            `json:"shell,omitempty"`
	Args        []string          `json:"args,omitempty"`
	Cols        int               `json:"cols"`
	Rows        int               `json:"rows"`
	Env         map[string]string `json:"env,omitempty"`
}

type SpawnResult struct {
	PID      int  `json:"pid"`
	Attached bool `json:"attached,omitempty"`
}

type WriteParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Data        string `json:"data"`
}

type ResizeParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
}

type AckParams struct {
	WorkspaceID   string `json:"workspaceId"`
	TabID         string `json:"tabId"`
	BytesConsumed int    `json:"bytesConsumed"`
}

type KillParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}

type ForegroundProcessParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Alone       bool   `json:"alone,omitempty"`
}

type ForegroundProcessResult struct {
	Name  string `json:"name"`
	Alone *bool  `json:"alone,omitempty"`
}

type ListeningPortsParams struct {
	WorkspaceID string `json:"workspaceId"`
}

type ListeningPort struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Process string `json:"process"`
	TabID   string `json:"tabId"`
}

type ListeningPortsResult struct {
	Ports []ListeningPort `json:"ports"`
}

type DataPayload struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Chunk       string `json:"chunk"`
	Replay      bool   `json:"replay,omitempty"`
}

type ExitPayload struct {
	WorkspaceID string  `json:"workspaceId"`
	TabID       string  `json:"tabId"`
	Code        *int    `json:"code"`
	Signal      *string `json:"signal,omitempty"`
}

type SessionListParams struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
}

type SessionInfo struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	CreatedAt   int64  `json:"createdAt"`
}

type SessionListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

type ReplayParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}
