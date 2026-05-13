// Package fsops implements the workspace-bound filesystem RPC methods
// exposed by the agent binary. Read methods (readdir / stat /
// readFile) live in this file; write methods are in write.go. Wire
// types are in types.go and stable error codes in errors.go.
//
// All paths are workspace-relative and resolved through `FS.Resolve`,
// which is the single trust boundary preventing escapes via `..` or
// absolute paths. Symlinks are walked with Lstat so a symlink pointing
// outside the workspace is reported as a symlink, not followed —
// matching the conservative read semantics of the legacy TS handlers.
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

// MaxReadableFileSize caps how many bytes one fs.readFile / fs.writeFile
// call may move. The threshold matches the renderer's editor capacity
// so we never produce a file that we couldn't reload. BinaryProbeBytes
// is the prefix we inspect to classify a file as binary.
const (
	MaxReadableFileSize = 5 * 1024 * 1024
	BinaryProbeBytes    = 512
)

// hiddenNames are directory entries that fs.readdir omits by default.
// The list mirrors the renderer's expectations: VCS metadata, build
// outputs, dependency vendoring, and OS noise. Surfaced explicitly so
// changes here are visible in code review rather than hidden in a
// runtime config file.
var hiddenNames = map[string]struct{}{
	".git": {}, "node_modules": {}, "dist": {}, "out": {}, ".DS_Store": {},
	".next": {}, ".turbo": {}, ".cache": {}, ".vscode-test": {},
}

// FS is the workspace-bound filesystem handle. One per agent
// process — `root` is fixed at startup and Resolve refuses anything
// escaping it.
type FS struct {
	root string
}

// params is the shared "single relPath" envelope shape used by readdir
// / stat / readFile. Write methods declare richer payloads in types.go.
type params struct {
	RelPath string `json:"relPath"`
}

// DirEntry is the wire shape for one entry returned by fs.readdir.
// Mirrors `src/shared/types/fs.ts` DirEntrySchema.
type DirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// StatResult is the wire shape returned by fs.stat. Mirrors FsStatSchema.
type StatResult struct {
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	MTime     string `json:"mtime"`
	IsSymlink bool   `json:"isSymlink"`
}

// ReadFileResult is the wire shape for fs.readFile. Two variants on
// the wire: "ok" carries content + encoding + size + isBinary + mtime;
// "missing" carries only `reason`. A custom MarshalJSON enforces that
// each variant emits exactly the fields the renderer's discriminated
// union expects — Go's struct-tag approach can't model "field present
// only when kind=X", so we drop to manual marshaling.
type ReadFileResult struct {
	Kind     string
	Content  string
	Encoding string
	Size     int64
	IsBinary bool
	MTime    string
	Reason   string
}

// FSError carries a stable wire code plus a human-readable path
// fragment. Implements the `ErrorCode() string` mini-interface that
// proto.ErrorCode consults, so domain errors keep their identity
// across the dispatcher boundary.
type FSError struct {
	Code string
	Path string
}

// Error implements the standard error interface — the message is
// machine-parseable ("CODE: path") so the renderer's hasFsErrorCode
// helper matches reliably.
func (e FSError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Path) }

// ErrorCode exposes the wire code to proto.ErrorCode without leaking
// FSError as a concrete type to the proto package.
func (e FSError) ErrorCode() string { return e.Code }

// MarshalJSON emits one of two object shapes based on Kind. See the
// ReadFileResult docstring for why this can't be expressed via struct
// tags alone.
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

// New constructs an FS rooted at the given absolute path. The path is
// cleaned and canonicalized once so subsequent Resolve calls can
// short-circuit on string-prefix checks.
func New(root string) (*FS, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &FS{root: filepath.Clean(abs)}, nil
}

// Register binds every fs.* method this package implements onto the
// dispatcher. Adding a new method means: implement it, add a line
// here, mirror the wire types in `src/shared/protocol/agent/fs.ts`.
func Register(d *dispatch.Dispatcher, fsys *FS) {
	d.Register("fs.readdir", fsys.Readdir)
	d.Register("fs.stat", fsys.Stat)
	d.Register("fs.readFile", fsys.ReadFile)
	d.Register("fs.writeFile", fsys.WriteFile)
}

// Readdir lists the entries at relPath, omitting names in `hiddenNames`.
// Returns an empty array for an empty directory rather than nil so the
// JSON wire form is `[]`, not `null`.
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

// Stat returns Lstat metadata for relPath. Symlinks are reported as
// symlinks (IsSymlink=true) and the size is the link's own size, not
// the target's — the renderer decides whether to follow.
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

// ReadFile loads relPath's contents up to MaxReadableFileSize.
// Directories are rejected with IS_DIRECTORY; missing files resolve to
// `{kind:"missing", reason:"not-found"}` instead of throwing so the
// renderer's "open after rename" UX doesn't surface as an error toast.
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
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
	}
	if info.Size() > MaxReadableFileSize {
		return nil, FSError{Code: CodeTooLarge, Path: fmt.Sprintf("%s (%d bytes)", abs, info.Size())}
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	buf, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// TOCTOU: file disappeared between Lstat and ReadFile.
			// Treat the second "missing" the same as the first.
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	return buildFileContent(buf, info), nil
}

// Resolve joins relPath against the workspace root and returns the
// cleaned absolute path. Refuses anything that escapes the root via
// `..` or an absolute path — the OUT_OF_WORKSPACE code surfaces that
// to the renderer so it can show a security-flavored toast.
//
// Exported because the write handlers (write.go) reuse it; the resolve
// helper below is the read-side adapter that also parses the params
// envelope.
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
		return "", FSError{Code: CodeOutOfWorkspace, Path: relPath}
	}
	return abs, nil
}

// resolve unmarshals the params envelope and delegates to Resolve.
// Used by readdir / stat / readFile, all of which share the same
// {relPath} param shape.
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

// entryType classifies one DirEntry as "dir" / "symlink" / "file".
// Symlinks are not followed — the renderer chooses whether to.
func entryType(entry os.DirEntry) string {
	if entry.IsDir() {
		return "dir"
	}
	if entry.Type()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

// fileInfoType is the same classifier as entryType but for FileInfo.
// Both shapes appear because os.ReadDir hands out DirEntry while
// os.Lstat hands out FileInfo.
func fileInfoType(info os.FileInfo) string {
	if info.IsDir() {
		return "dir"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

// buildFileContent classifies the read bytes (binary vs text vs BOM)
// and packs them into the "ok" variant of ReadFileResult.
//
//   - Binary detection wins first so we never ship NUL bytes through
//     a JSON string into the renderer.
//   - The UTF-8 BOM is stripped from the content but recorded in
//     `encoding` so a subsequent write can re-emit it.
//   - Non-UTF-8 text is repaired with the replacement character
//     rather than rejected, matching the renderer's lossy-display
//     behavior.
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

// isBinaryProbe returns true when the prefix looks like a binary file
// — UTF-16/32 BOM or any NUL byte. Cheap and matches the heuristic the
// TS read handler uses.
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

// formatMTime renders a time as the wire-format ISO 8601 string used
// across all fs methods. Matches the renderer's `new Date(...).toISOString()`
// output byte-for-byte so equality comparisons (expected.mtime ===
// stat.mtime) round-trip without normalization.
func formatMTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// mapPathError translates a syscall-flavored error into the wire FSError
// vocabulary. Only the read-side errnos live here; write.go adds ENOSPC
// and EXDEV through its own wrapper so the read path doesn't import
// codes it never produces.
func mapPathError(err error, path string) error {
	if errors.Is(err, fs.ErrNotExist) {
		return FSError{Code: CodeNotFound, Path: path}
	}
	if errors.Is(err, fs.ErrPermission) {
		return FSError{Code: CodePermissionDenied, Path: path}
	}
	if runtime.GOOS == "windows" && strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		// Windows surfaces some permission failures without setting
		// fs.ErrPermission. Fall back to a string match — fragile,
		// but no worse than the legacy TS handler did.
		return FSError{Code: CodePermissionDenied, Path: path}
	}
	return err
}
