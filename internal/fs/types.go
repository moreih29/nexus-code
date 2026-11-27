package fs

import "encoding/json"

type DirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size *int64 `json:"size,omitempty"`
}

type StatResult struct {
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	MTime     string `json:"mtime"`
	IsSymlink bool   `json:"isSymlink"`
}

type ReadFileResult struct {
	Kind     string
	Content  string
	Encoding string
	Bytes    []byte
	Size     int64
	IsBinary bool
	MTime    string
	Reason   string
}

type ReadAbsoluteParams struct {
	AbsolutePath string `json:"absolutePath"`
}

type ReadRangeParams struct {
	Offset int64 `json:"offset"`
	Length int64 `json:"length"`
}

type ReadBinaryResult struct {
	Kind    string
	Base64  string
	Size    int64
	MTime   string
	Version string
	Reason  string
}

func (r ReadBinaryResult) MarshalJSON() ([]byte, error) {
	if r.Kind == "missing" {
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		}{Kind: r.Kind, Reason: r.Reason})
	}
	return json.Marshal(struct {
		Kind    string `json:"kind"`
		Base64  string `json:"base64"`
		Size    int64  `json:"sizeBytes"`
		MTime   string `json:"mtime"`
		Version string `json:"version,omitempty"`
	}{Kind: r.Kind, Base64: r.Base64, Size: r.Size, MTime: r.MTime, Version: r.Version})
}

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
		Bytes    []byte `json:"bytes,omitempty"`
		Size     int64  `json:"sizeBytes"`
		IsBinary bool   `json:"isBinary"`
		MTime    string `json:"mtime"`
	}{Kind: r.Kind, Content: r.Content, Encoding: r.Encoding, Bytes: r.Bytes, Size: r.Size, IsBinary: r.IsBinary, MTime: r.MTime})
}

type ExpectedFileState struct {
	Exists bool    `json:"exists"`
	MTime  *string `json:"mtime,omitempty"`
	Size   *int64  `json:"size,omitempty"`
}

type WriteFileParams struct {
	RelPath  string             `json:"relPath"`
	Content  string             `json:"content"`
	Bytes    []byte             `json:"bytes,omitempty"`
	Expected *ExpectedFileState `json:"expected,omitempty"`
}

type WriteFileResult struct {
	Kind   string             `json:"kind"`
	MTime  *string            `json:"mtime,omitempty"`
	Size   *int64             `json:"size,omitempty"`
	Actual *ExpectedFileState `json:"actual,omitempty"`
}

type CreateFileParams struct {
	RelPath string `json:"relPath"`
}

type MkdirParams struct {
	RelPath   string `json:"relPath"`
	Recursive bool   `json:"recursive,omitempty"`
}

type ReaddirParams struct {
	IncludeHidden bool `json:"includeHidden"`
}

type WatchParams struct {
	RelPath string `json:"relPath"`
}

type UnlinkParams struct {
	RelPath string `json:"relPath"`
}

type RmdirParams struct {
	RelPath string `json:"relPath"`
}

type RenameParams struct {
	FromRelPath string `json:"fromRelPath"`
	ToRelPath   string `json:"toRelPath"`
	Overwrite   bool   `json:"overwrite,omitempty"`
}

type CopyFileParams struct {
	FromRelPath string `json:"fromRelPath"`
	ToRelPath   string `json:"toRelPath"`
	Overwrite   bool   `json:"overwrite,omitempty"`
}

type RemoveAllParams struct {
	RelPath string `json:"relPath"`
}
