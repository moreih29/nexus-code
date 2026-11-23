package chat

import (
	"encoding/json"
	"time"
)

const (
	EventLine = "chat.line"
	EventExit = "chat.exit"

	DirOut = "out"
	DirIn  = "in"
	DirSys = "sys"

	maxLineBytes    = 48 * 1024 * 1024
	logCapBytes     = 32 * 1024 * 1024
	stderrTailBytes = 16 * 1024
	exitDrainGrace  = 500 * time.Millisecond

	execTimeout        = 30 * time.Second
	execOutputCap      = 1024 * 1024
	transcriptCapBytes = 32 * 1024 * 1024
)

var stopGrace = 3 * time.Second

type EventSink func(event string, payload any) error

type StartParams struct {
	WorkspaceID       string            `json:"workspaceId"`
	TabID             string            `json:"tabId"`
	TabGeneration     string            `json:"tabGeneration,omitempty"`
	Cwd               string            `json:"cwd"`
	Program           string            `json:"program"`
	Args              []string          `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	ResetLog          bool              `json:"resetLog,omitempty"`
	Resumed           bool              `json:"resumed,omitempty"`
	ConnectionChanged bool              `json:"connectionChanged,omitempty"`
}

type StartResult struct {
	PID          int    `json:"pid"`
	Attached     bool   `json:"attached,omitempty"`
	CanonicalCwd string `json:"canonicalCwd,omitempty"`
}

type SendParams struct {
	WorkspaceID  string          `json:"workspaceId"`
	TabID        string          `json:"tabId"`
	Message      json.RawMessage `json:"message"`
	CodexContext *codexContext   `json:"codexContext,omitempty"`
}

type TabParams struct {
	WorkspaceID     string `json:"workspaceId"`
	TabID           string `json:"tabId"`
	TabGeneration   string `json:"tabGeneration,omitempty"`
	KeepAttachments bool   `json:"keepAttachments,omitempty"`
}

type ReplayParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	AfterSeq    int64  `json:"afterSeq,omitempty"`
}

type ReplayResult struct {
	Found     bool  `json:"found"`
	Running   bool  `json:"running"`
	Truncated bool  `json:"truncated,omitempty"`
	LastSeq   int64 `json:"lastSeq"`
}

type ListParams struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
}

type SessionInfo struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	PID         int    `json:"pid"`
	Running     bool   `json:"running"`
	CreatedAt   int64  `json:"createdAt"`
}

type ListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

type LinePayload struct {
	WorkspaceID       string          `json:"workspaceId"`
	TabID             string          `json:"tabId"`
	Seq               int64           `json:"seq"`
	Dir               string          `json:"dir"`
	Message           json.RawMessage `json:"message,omitempty"`
	Text              string          `json:"text,omitempty"`
	ProcessGeneration string          `json:"processGeneration,omitempty"`
	At                int64           `json:"at"`
	Replay            bool            `json:"replay,omitempty"`
}

type ExitPayload struct {
	WorkspaceID       string  `json:"workspaceId"`
	TabID             string  `json:"tabId"`
	Code              *int    `json:"code"`
	Signal            *string `json:"signal,omitempty"`
	StderrTail        string  `json:"stderrTail,omitempty"`
	ProcessGeneration string  `json:"processGeneration,omitempty"`
}

type ExecParams struct {
	Cwd       string            `json:"cwd,omitempty"`
	Program   string            `json:"program"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	TimeoutMs int               `json:"timeoutMs,omitempty"`
}

type ExecResult struct {
	Code     int    `json:"code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timedOut,omitempty"`
}

type TranscriptParams struct {
	SessionID string `json:"sessionId"`
	ConfigDir string `json:"configDir,omitempty"`
}

type TranscriptResult struct {
	Found     bool              `json:"found"`
	Lines     []json.RawMessage `json:"lines"`
	Truncated bool              `json:"truncated,omitempty"`
}

type SubagentTranscriptParams struct {
	SessionID string `json:"sessionId"`
	AgentID   string `json:"agentId,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
	ConfigDir string `json:"configDir,omitempty"`
}

type SubagentTranscriptResult struct {
	Found     bool              `json:"found"`
	Lines     []json.RawMessage `json:"lines"`
	Truncated bool              `json:"truncated,omitempty"`
}

type SessionFileParams struct {
	SessionID string `json:"sessionId"`
	ConfigDir string `json:"configDir,omitempty"`
}

type SessionFileResult struct {
	Found bool   `json:"found"`
	Path  string `json:"path,omitempty"`
}

type RolloutTailParams struct {
	ThreadID  string `json:"threadId"`
	CodexHome string `json:"codexHome,omitempty"`
	Turns     int    `json:"turns,omitempty"`
}

type RolloutTailResult struct {
	Found  bool           `json:"found"`
	Events []RolloutEvent `json:"events"`
	More   bool           `json:"more,omitempty"`
}

type RolloutEvent struct {
	Kind     string   `json:"kind"`
	TurnID   string   `json:"turnId,omitempty"`
	Text     string   `json:"text,omitempty"`
	Images   int      `json:"images,omitempty"`
	ClientID string   `json:"clientId,omitempty"`
	Tool     string   `json:"tool,omitempty"`
	Changes  []string `json:"changes,omitempty"`
	Server   string   `json:"server,omitempty"`
	Name     string   `json:"name,omitempty"`
}

type StageThreadParams struct {
	ThreadID string `json:"threadId"`
	From     string `json:"from,omitempty"`
	To       string `json:"to,omitempty"`
}

type StageThreadResult struct {
	Found bool `json:"found"`
}

type ClaudeConfigParams struct {
	ConfigDir string `json:"configDir,omitempty"`
}

type ClaudeConfigResult struct {
	Found  bool                       `json:"found"`
	Values map[string]json.RawMessage `json:"values"`
}

type SessionsParams struct {
	Cwd       string `json:"cwd"`
	ConfigDir string `json:"configDir,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type SessionsResult struct {
	Sessions []ClaudeSession `json:"sessions"`
}

type DeleteSessionParams struct {
	Cwd       string `json:"cwd"`
	SessionID string `json:"sessionId"`
	ConfigDir string `json:"configDir,omitempty"`
}

type DeleteSessionResult struct {
	Deleted bool `json:"deleted"`
}

type FileSizesParams struct {
	Paths []string `json:"paths"`
}

type FileSizesResult struct {
	Sizes map[string]int64 `json:"sizes"`
}

type ClaudeSession struct {
	SessionID    string `json:"sessionId"`
	Title        string `json:"title"`
	CustomTitle  string `json:"customTitle,omitempty"`
	FirstPrompt  string `json:"firstPrompt,omitempty"`
	GitBranch    string `json:"gitBranch,omitempty"`
	LastModified int64  `json:"lastModified"`
	CreatedAt    int64  `json:"createdAt,omitempty"`
	Size         int64  `json:"size"`
}
