// Package chat runs the conversation programs behind the app's Claude tabs:
// `claude -p` in stream-json mode, one process per tab. It relays the
// program's stdout lines to the app as events and writes the app's lines to
// its stdin, as internal/lsp does for language servers.
//
// The agent owns the process, so a conversation outlives the app's
// connection: an SSH disconnect, a window reload, or an app restart while a
// remote daemon keeps running. Every line in either direction is kept in a
// log, so a client that comes back replays the log and rebuilds what it
// showed.
package chat

import (
	"encoding/json"
	"time"
)

const (
	// EventLine carries one line of the conversation, either way.
	EventLine = "chat.line"
	// EventExit is sent once when a tab's program exits.
	EventExit = "chat.exit"

	// DirOut is a line the program wrote, DirIn one the app sent it, and
	// DirSys one the agent adds: the program starting and exiting.
	DirOut = "out"
	DirIn  = "in"
	DirSys = "sys"

	// maxLineBytes caps one line from the program. Images travel inline as
	// base64, so a line can be several megabytes.
	maxLineBytes = 48 * 1024 * 1024
	// logCapBytes caps what a tab's log keeps; the oldest lines go first.
	logCapBytes = 32 * 1024 * 1024
	// stderrTailBytes is how much of the program's stderr the exit reports.
	stderrTailBytes = 16 * 1024
	// stopGrace is how long a stopped program has to exit before it is killed.
	stopGrace = 3 * time.Second
	// exitDrainGrace lets the readers reach EOF before the exit is reported.
	exitDrainGrace = 500 * time.Millisecond

	// execTimeout bounds a chat.exec run; execOutputCap its kept output.
	execTimeout   = 30 * time.Second
	execOutputCap = 1024 * 1024
	// transcriptCapBytes caps what chat.transcript returns, from the end.
	transcriptCapBytes = 32 * 1024 * 1024
)

// EventSink is the callback the service pushes events through.
type EventSink func(event string, payload any) error

// StartParams is the wire shape for chat.start.
type StartParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Cwd         string `json:"cwd"`
	// Program is the program to run, an absolute path on the agent's host.
	Program string            `json:"program"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// ResetLog drops the tab's log before the program starts: the
	// conversation it showed is not the one the program goes on with, as
	// after a rewind. Sequence numbers go on from the dropped lines.
	ResetLog bool `json:"resetLog,omitempty"`
	// Resumed marks a program that goes on with an earlier session, so a
	// client replaying the log reads what came before from its transcript.
	Resumed bool `json:"resumed,omitempty"`
}

// StartResult is returned by chat.start.
type StartResult struct {
	PID int `json:"pid"`
	// Attached reports that the tab's program was already running, so none
	// was started. The client replays the log to show it.
	Attached bool `json:"attached,omitempty"`
}

// SendParams is the wire shape for chat.send. Message is one JSON value,
// written to the program as one line.
type SendParams struct {
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Message     json.RawMessage `json:"message"`
}

// TabParams names one tab, for chat.stop and chat.close.
type TabParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
}

// ReplayParams is the wire shape for chat.replay.
type ReplayParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	// AfterSeq replays only the lines after this one; 0 replays the log.
	AfterSeq int64 `json:"afterSeq,omitempty"`
}

// ReplayResult is returned by chat.replay, after the replayed lines.
type ReplayResult struct {
	// Found is false when the agent has no log for the tab.
	Found   bool `json:"found"`
	Running bool `json:"running"`
	// Truncated reports that the log dropped its oldest lines.
	Truncated bool `json:"truncated,omitempty"`
	// LastSeq is the seq of the last line the replay sent, or afterSeq when
	// it sent none. The lines go out as events, which may reach the client
	// after this answer: it has the log once it has this line.
	LastSeq int64 `json:"lastSeq"`
}

// ListParams is the wire shape for chat.list.
type ListParams struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// SessionInfo describes one tab the agent has a log for.
type SessionInfo struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	PID         int    `json:"pid"`
	Running     bool   `json:"running"`
	// CreatedAt is when the log was started, in Unix milliseconds.
	CreatedAt int64 `json:"createdAt"`
}

// ListResult is returned by chat.list.
type ListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// LinePayload is one chat.line event. A line from the program that is not
// JSON comes as Text; every other line as Message.
type LinePayload struct {
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Seq         int64           `json:"seq"`
	Dir         string          `json:"dir"`
	Message     json.RawMessage `json:"message,omitempty"`
	Text        string          `json:"text,omitempty"`
	// At is when the agent got the line, in Unix milliseconds.
	At int64 `json:"at"`
	// Replay marks a line sent again by chat.replay.
	Replay bool `json:"replay,omitempty"`
}

// ExitPayload is the chat.exit event.
type ExitPayload struct {
	WorkspaceID string  `json:"workspaceId"`
	TabID       string  `json:"tabId"`
	Code        *int    `json:"code"`
	Signal      *string `json:"signal,omitempty"`
	StderrTail  string  `json:"stderrTail,omitempty"`
}

// ExecParams is the wire shape for chat.exec: a short run of the program,
// such as `claude --version`.
type ExecParams struct {
	Cwd     string            `json:"cwd,omitempty"`
	Program string            `json:"program"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// TimeoutMs bounds the run; 0 or more than 30 s means 30 s.
	TimeoutMs int `json:"timeoutMs,omitempty"`
}

// ExecResult is returned by chat.exec.
type ExecResult struct {
	// Code is the exit code, -1 when the program was killed or did not start.
	Code     int    `json:"code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timedOut,omitempty"`
}

// TranscriptParams is the wire shape for chat.transcript.
type TranscriptParams struct {
	SessionID string `json:"sessionId"`
	// ConfigDir is the program's config directory, "~" for the home;
	// empty means CLAUDE_CONFIG_DIR, else ~/.claude.
	ConfigDir string `json:"configDir,omitempty"`
}

// TranscriptResult is returned by chat.transcript: the session's transcript
// lines, the last ones when it is larger than the cap.
type TranscriptResult struct {
	Found     bool              `json:"found"`
	Lines     []json.RawMessage `json:"lines"`
	Truncated bool              `json:"truncated,omitempty"`
}
