package fsops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	MaxReadableFileSize = 5 * 1024 * 1024
	BinaryProbeBytes    = 512
)

var hiddenNames = map[string]struct{}{
	".git": {}, "node_modules": {}, "dist": {}, "out": {}, ".DS_Store": {},
	".next": {}, ".turbo": {}, ".cache": {}, ".vscode-test": {},
}

type FS struct {
	root string
}

type params struct {
	RelPath string `json:"relPath"`
}

type DirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
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
	Size     int64
	IsBinary bool
	MTime    string
	Reason   string
}

type FSError struct {
	Code string
	Path string
}

func (e FSError) Error() string     { return fmt.Sprintf("%s: %s", e.Code, e.Path) }
func (e FSError) ErrorCode() string { return e.Code }

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

func New(root string) (*FS, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &FS{root: filepath.Clean(abs)}, nil
}

func Register(d *dispatch.Dispatcher, fsys *FS) {
	d.Register("fs.readdir", fsys.Readdir)
	d.Register("fs.stat", fsys.Stat)
	d.Register("fs.readFile", fsys.ReadFile)
}

func (f *FS) Readdir(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := f.resolve(raw)
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		if _, hidden := hiddenNames[entry.Name()]; hidden {
			continue
		}
		out = append(out, DirEntry{Name: entry.Name(), Type: entryType(entry)})
	}
	return out, nil
}

func (f *FS) Stat(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := f.resolve(raw)
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	return StatResult{Type: fileInfoType(info), Size: info.Size(), MTime: formatMTime(info.ModTime()), IsSymlink: info.Mode()&os.ModeSymlink != 0}, nil
}

func (f *FS) ReadFile(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := f.resolve(raw)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	if info.IsDir() {
		return nil, FSError{Code: "IS_DIRECTORY", Path: abs}
	}
	if info.Size() > MaxReadableFileSize {
		return nil, FSError{Code: "TOO_LARGE", Path: fmt.Sprintf("%s (%d bytes)", abs, info.Size())}
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	buf, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	return buildFileContent(buf, info), nil
}

func (f *FS) Resolve(relPath string) (string, error) {
	if relPath == "" {
		relPath = "."
	}
	abs := filepath.Clean(filepath.Join(f.root, relPath))
	rel, err := filepath.Rel(f.root, abs)
	if err != nil {
		return "", err
	}
	if rel == "" || rel == "." {
		return abs, nil
	}
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", FSError{Code: "OUT_OF_WORKSPACE", Path: relPath}
	}
	return abs, nil
}

func (f *FS) resolve(raw json.RawMessage) (string, error) {
	var envelope map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &envelope) != nil {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	relRaw, ok := envelope["relPath"]
	if !ok {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	var p params
	if json.Unmarshal(relRaw, &p.RelPath) != nil {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	return f.Resolve(p.RelPath)
}

func entryType(entry os.DirEntry) string {
	if entry.IsDir() {
		return "dir"
	}
	if entry.Type()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

func fileInfoType(info os.FileInfo) string {
	if info.IsDir() {
		return "dir"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

func buildFileContent(buf []byte, info os.FileInfo) ReadFileResult {
	probe := buf
	if len(probe) > BinaryProbeBytes {
		probe = probe[:BinaryProbeBytes]
	}
	mtime := formatMTime(info.ModTime())
	if isBinaryProbe(probe) {
		return ReadFileResult{Kind: "ok", Content: "", Encoding: "utf8", Size: info.Size(), IsBinary: true, MTime: mtime}
	}
	if len(probe) >= 3 && probe[0] == 0xef && probe[1] == 0xbb && probe[2] == 0xbf {
		return ReadFileResult{Kind: "ok", Content: string(buf[3:]), Encoding: "utf8-bom", Size: info.Size(), IsBinary: false, MTime: mtime}
	}
	content := string(buf)
	if !utf8.Valid(buf) {
		content = strings.ToValidUTF8(content, "�")
	}
	return ReadFileResult{Kind: "ok", Content: content, Encoding: "utf8", Size: info.Size(), IsBinary: false, MTime: mtime}
}

func isBinaryProbe(probe []byte) bool {
	if len(probe) >= 2 && ((probe[0] == 0xff && probe[1] == 0xfe) || (probe[0] == 0xfe && probe[1] == 0xff)) {
		return true
	}
	for _, b := range probe {
		if b == 0x00 {
			return true
		}
	}
	return false
}

func formatMTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func mapPathError(err error, path string) error {
	if errors.Is(err, fs.ErrNotExist) {
		return FSError{Code: "NOT_FOUND", Path: path}
	}
	if errors.Is(err, fs.ErrPermission) {
		return FSError{Code: "PERMISSION_DENIED", Path: path}
	}
	if runtime.GOOS == "windows" && strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		return FSError{Code: "PERMISSION_DENIED", Path: path}
	}
	return err
}
