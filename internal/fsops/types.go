package fsops

// Wire types for the fs.* write methods on the agent NDJSON channel.
// Mirrors `src/shared/protocol/agent/fs.ts`. The TS side is the zod
// source of truth; this file is the hand-maintained Go reflection. Keep
// JSON field names byte-identical — the round-trip integration tests
// catch drift, but consistency in this file makes review trivial.

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
