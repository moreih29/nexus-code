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

	// RingCapBytes is the per-session ring buffer capacity.
	// Sized near the existing flow-control high-watermark (1 MiB) so a single
	// replay fits within one credit gate window.  When the ring is full the
	// oldest bytes are dropped — preserving the most-recent screen state is the
	// goal, not full scrollback.
	RingCapBytes = 1 * 1024 * 1024
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

// ForegroundProcessParams is the wire shape for pty.foregroundProcess.
// Returns the basename of the program currently in the PTY foreground process
// group — used by the renderer to label tabs running OSC-mute TUIs (lazygit,
// lazydocker, vim, less, htop). For OSC-aware programs (claude), the OSC title
// path runs in parallel and typically wins; the two are consistent in practice.
type ForegroundProcessParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}

// ForegroundProcessResult returns the basename of the foreground process group
// leader, or empty string when the lookup fails (no session, ioctl error, or ps
// failure). Callers treat an empty name as "no info" and skip the tab update —
// never overwriting a previously-set title with empty.
type ForegroundProcessResult struct {
	Name string `json:"name"`
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

// SessionListParams is the wire shape for session.list.
// WorkspaceID filters to a single workspace; omit for all live sessions.
type SessionListParams struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// SessionInfo describes one live PTY session returned by session.list.
// The client uses tabId to match against its pending tab state and to
// call pty.replay after a reattach.
type SessionInfo struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	// CreatedAt is the Unix millisecond timestamp when the PTY was spawned.
	// Clients can use it to detect whether a tab predates or postdates the
	// dialer disconnect — without inventing new state beyond what the service
	// already tracks.
	CreatedAt int64 `json:"createdAt"`
}

// SessionListResult is the wire shape returned by session.list.
type SessionListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// ReplayParams is the wire shape for pty.replay.
type ReplayParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}
