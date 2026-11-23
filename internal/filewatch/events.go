package filewatch

type FsChangeKind string

const (
	FsChangeAdded    FsChangeKind = "added"
	FsChangeModified FsChangeKind = "modified"
	FsChangeDeleted  FsChangeKind = "deleted"
)

type FsChange struct {
	RelPath string       `json:"relPath"`
	Kind    FsChangeKind `json:"kind"`
}

type FsChangedPayload struct {
	Changes []FsChange `json:"changes"`
}
