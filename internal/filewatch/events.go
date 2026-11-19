// Package filewatch defines the agent's file change events.
package filewatch

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
