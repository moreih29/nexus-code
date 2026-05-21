package pty

import "time"

const (
	// EventData is the server-push event carrying one base64 PTY output chunk.
	EventData = "pty.data"
	// EventExit is the server-push event carrying the child process exit status.
	EventExit = "pty.exit"

	// HighWatermarkBytes is the maximum semantic renderer debt before PTY reads pause.
	HighWatermarkBytes = 100_000
	// LowWatermarkBytes is the renderer debt threshold at which paused PTY reads resume.
	LowWatermarkBytes = 5_000
	// MaxChunkSize is the largest raw PTY output chunk emitted in one data event.
	MaxChunkSize = 4 * 1024
	// maxWriteChunkSize caps one master-side write to avoid platform PTY write stalls.
	maxWriteChunkSize = 1024
	// exitDrainGrace lets the reader flush trailing PTY bytes before exit is reported.
	exitDrainGrace = 150 * time.Millisecond
)

// EventSink is the callback pty uses to push agent events back to Electron.
type EventSink func(event string, payload any) error

// SpawnParams is the wire shape for pty.spawn.
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

// SpawnResult is the wire shape returned after a PTY child starts.
type SpawnResult struct {
	PID int `json:"pid"`
}

// WriteParams is the wire shape for pty.write.
type WriteParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Data        string `json:"data"`
}

// ResizeParams is the wire shape for pty.resize.
type ResizeParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
}

// AckParams is the wire shape for pty.ack.
type AckParams struct {
	WorkspaceID   string `json:"workspaceId"`
	TabID         string `json:"tabId"`
	BytesConsumed int    `json:"bytesConsumed"`
}

// KillParams is the wire shape for pty.kill.
type KillParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}

// DataPayload is emitted on pty.data with Chunk carrying base64 raw PTY bytes.
type DataPayload struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Chunk       string `json:"chunk"`
}

// ExitPayload is emitted once when a PTY child terminates.
type ExitPayload struct {
	WorkspaceID string  `json:"workspaceId"`
	TabID       string  `json:"tabId"`
	Code        *int    `json:"code"`
	Signal      *string `json:"signal,omitempty"`
}
