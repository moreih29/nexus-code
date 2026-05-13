package fs

import "encoding/json"

// Wire types for the fs.* methods on the agent NDJSON channel. The TS side is
// the zod source of truth; this file is the hand-maintained Go reflection.

// DirEntry is the wire shape for one entry returned by fs.readdir.
type DirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// FsChangeKind is the wire enum used by fs.changed event payloads.
type FsChangeKind string

const (
	FsChangeAdded    FsChangeKind = "added"
	FsChangeModified FsChangeKind = "modified"
	FsChangeDeleted  FsChangeKind = "deleted"
)

// FsChange is one path change in an fs.changed event.
type FsChange struct {
	RelPath string       `json:"relPath"`
	Kind    FsChangeKind `json:"kind"`
}

// FsChangedPayload is emitted by the agent. Electron adds workspaceId before
// forwarding it to renderer IPC subscribers.
type FsChangedPayload struct {
	Changes []FsChange `json:"changes"`
}

// StatResult is the wire shape returned by fs.stat.
type StatResult struct {
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	MTime     string `json:"mtime"`
	IsSymlink bool   `json:"isSymlink"`
}

// ReadFileResult is the wire shape for fs.readFile. A custom MarshalJSON
// enforces the renderer's discriminated-union variants.
type ReadFileResult struct {
	Kind     string
	Content  string
	Encoding string
	Size     int64
	IsBinary bool
	MTime    string
	Reason   string
}

// ReadAbsoluteParams — fs.readAbsolute request shape. The path is intentionally
// not workspace-relative; it is interpreted on the machine where the agent runs.
type ReadAbsoluteParams struct {
	AbsolutePath string `json:"absolutePath"`
}

// MarshalJSON emits one of two object shapes based on Kind.
func (r ReadFileResult) MarshalJSON() ([]byte, error) {
	if r.Kind == "missing" {
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		}{Kind: r.Kind, Reason: r.Reason})
	}
	return json.Marshal(struct {
		Kind     string `json:"kind"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
		Size     int64  `json:"sizeBytes"`
		IsBinary bool   `json:"isBinary"`
		MTime    string `json:"mtime"`
	}{Kind: r.Kind, Content: r.Content, Encoding: r.Encoding, Size: r.Size, IsBinary: r.IsBinary, MTime: r.MTime})
}

// ExpectedFileState mirrors the TS ExpectedFileStateSchema discriminated
// union. Pointer fields are necessary because the "exists:true" variant
// must serialize Size=0 as a valid value, while the "exists:false" variant
// must omit MTime/Size entirely. omitempty on a pointer drops only nil.
type ExpectedFileState struct {
	Exists bool    `json:"exists"`
	MTime  *string `json:"mtime,omitempty"`
	Size   *int64  `json:"size,omitempty"`
}

// WriteFileParams — fs.writeFile request shape.
type WriteFileParams struct {
	RelPath  string             `json:"relPath"`
	Content  string             `json:"content"`
	Expected *ExpectedFileState `json:"expected,omitempty"`
}

// WriteFileResult mirrors the TS WriteFileResultSchema (kind: "ok" | "conflict").
// MTime + Size populate the "ok" variant; Actual populates the "conflict"
// variant. Pointer + omitempty keeps the wire shape a true discriminated
// union rather than always-emitting-empty fields.
type WriteFileResult struct {
	Kind   string             `json:"kind"`
	MTime  *string            `json:"mtime,omitempty"`
	Size   *int64             `json:"size,omitempty"`
	Actual *ExpectedFileState `json:"actual,omitempty"`
}

// CreateFileParams — fs.createFile request shape.
type CreateFileParams struct {
	RelPath string `json:"relPath"`
}

// MkdirParams — fs.mkdir request shape. Recursive defaults to false on
// absence; the server treats omitted and explicit-false identically.
type MkdirParams struct {
	RelPath   string `json:"relPath"`
	Recursive bool   `json:"recursive,omitempty"`
}

// WatchParams — fs.watch / fs.unwatch request shape.
type WatchParams struct {
	RelPath string `json:"relPath"`
}

// UnlinkParams — fs.unlink request shape.
type UnlinkParams struct {
	RelPath string `json:"relPath"`
}

// RmdirParams — fs.rmdir request shape.
type RmdirParams struct {
	RelPath string `json:"relPath"`
}

// RenameParams — fs.rename request shape.
type RenameParams struct {
	FromRelPath string `json:"fromRelPath"`
	ToRelPath   string `json:"toRelPath"`
}
