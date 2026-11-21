package fs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	iofs "io/fs"
	"os"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// hiddenNames are directory entries that fs.readdir omits by default and the
// watcher never reports. Only VCS/OS metadata the explorer should never show
// (VS Code's files.exclude defaults) — build and dependency folders such as
// node_modules or dist are real workspace content and stay visible.
var hiddenNames = map[string]struct{}{
	".git": {}, ".DS_Store": {},
}

// Readdir lists the entries at relPath, omitting names in hiddenNames unless
// the request sets includeHidden (name-collision checks need every entry).
func (s *Service) Readdir(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	var opts ReaddirParams
	_ = json.Unmarshal(raw, &opts)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		if _, hidden := hiddenNames[entry.Name()]; hidden && !opts.IncludeHidden {
			continue
		}
		out = append(out, DirEntry{Name: entry.Name(), Type: entryType(entry)})
	}
	return out, nil
}

// Stat returns Lstat metadata by default. An editor can ask for the target
// metadata used by ReadFile and WriteFile.
func (s *Service) Stat(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var options struct {
		FollowSymlink bool `json:"followSymlink"`
	}
	if err := json.Unmarshal(raw, &options); err != nil {
		return nil, proto.ProtocolError("invalid fs.stat options")
	}
	stat := os.Lstat
	if options.FollowSymlink {
		stat = os.Stat
	}
	info, err := stat(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	return StatResult{
		Type:      fileInfoType(info),
		Size:      info.Size(),
		MTime:     formatMTime(info.ModTime()),
		IsSymlink: info.Mode()&os.ModeSymlink != 0,
	}, nil
}

// ReadFile loads relPath's contents up to MaxReadableFileSize. Missing files
// resolve to a "missing" result so renderer file-open races do not surface as
// error toasts.
func (s *Service) ReadFile(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	return readFileAt(ctx, abs)
}

// ReadAbsolute loads an absolute path on the agent host. This supports
// read-only external references such as LSP results outside the workspace.
func (s *Service) ReadAbsolute(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := parseAbsolutePath(raw)
	if err != nil {
		return nil, err
	}
	return readFileAt(ctx, abs)
}

// ReadAbsoluteBinary loads an absolute path's bytes on the agent host, as
// ReadBinary does a workspace file's. The app asks for it only for files a
// Claude tab links outside the workspace, to preview them.
func (s *Service) ReadAbsoluteBinary(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := parseAbsolutePath(raw)
	if err != nil {
		return nil, err
	}
	return readBinaryAt(ctx, abs)
}

// ReadBinary loads relPath's bytes (up to MaxReadableFileSize) and returns
// them base64-encoded. Used by the renderer's image preview pipeline for
// SSH workspaces, where binary bytes cannot be transported as a UTF-8
// content string the way fs.readFile does. Same missing-file handling so
// renderer races against fs.changed events do not surface as toasts.
func (s *Service) ReadBinary(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	return readBinaryAt(ctx, abs)
}

// ReadRange returns `length` bytes of relPath from `offset`, base64-encoded,
// with the file's size: at most MaxReadRangeLength, and fewer at the end of
// the file. The previews read large files with it in pieces, so they need
// not be read whole, and no piece holds the channel for long. A symlink is
// followed, as ReadBinary follows one.
func (s *Service) ReadRange(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	r, err := parseReadRange(raw)
	if err != nil {
		return nil, err
	}
	return readRangeAt(ctx, abs, r)
}

// ReadAbsoluteRange is ReadRange for an absolute path on the agent host, as
// ReadAbsoluteBinary is ReadBinary's: for files a Claude tab links outside
// the workspace.
func (s *Service) ReadAbsoluteRange(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := parseAbsolutePath(raw)
	if err != nil {
		return nil, err
	}
	r, err := parseReadRange(raw)
	if err != nil {
		return nil, err
	}
	return readRangeAt(ctx, abs, r)
}

func parseReadRange(raw json.RawMessage) (ReadRangeParams, error) {
	var r ReadRangeParams
	if json.Unmarshal(raw, &r) != nil || r.Offset < 0 || r.Length < 0 {
		return r, proto.ProtocolError("fs.readRange params must include a non-negative offset and length")
	}
	r.Length = min(r.Length, MaxReadRangeLength)
	return r, nil
}

func readRangeAt(ctx context.Context, abs string, r ReadRangeParams) (any, error) {
	// The size and time are the target's, not a link's, since the range is
	// of the bytes read.
	target, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return ReadBinaryResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	if target.IsDir() {
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	mtime := formatMTime(target.ModTime())
	// A device, FIFO or socket is not opened (a FIFO blocks until a writer
	// appears); it reads as empty.
	if !target.Mode().IsRegular() {
		return ReadBinaryResult{Kind: "ok", Base64: "", Size: 0, MTime: mtime}, nil
	}
	file, err := os.Open(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return ReadBinaryResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	defer file.Close()
	buf := make([]byte, max(0, min(r.Length, target.Size()-r.Offset)))
	n, err := file.ReadAt(buf, r.Offset)
	// A file cut short since the stat ends the range early.
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, mapPathError(err, abs)
	}
	return ReadBinaryResult{
		Kind:   "ok",
		Base64: base64.StdEncoding.EncodeToString(buf[:n]),
		Size:   target.Size(),
		MTime:  mtime,
	}, nil
}

func readBinaryAt(ctx context.Context, abs string) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	buf, info, err := readTarget(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return ReadBinaryResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	if !info.Mode().IsRegular() {
		return ReadBinaryResult{Kind: "ok", Base64: "", Size: info.Size(), MTime: formatMTime(info.ModTime())}, nil
	}
	return ReadBinaryResult{
		Kind:   "ok",
		Base64: base64.StdEncoding.EncodeToString(buf),
		Size:   info.Size(),
		MTime:  formatMTime(info.ModTime()),
	}, nil
}

func readFileAt(ctx context.Context, abs string) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	buf, info, err := readTarget(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	if !info.Mode().IsRegular() {
		return ReadFileResult{Kind: "ok", Content: "", Encoding: "utf8", Size: info.Size(), IsBinary: true, MTime: formatMTime(info.ModTime())}, nil
	}
	return buildFileContent(buf, info), nil
}

// readTarget returns the bytes and metadata of the same file, following
// symlinks. A device, FIFO or socket is reported without opening it.
func readTarget(abs string) ([]byte, os.FileInfo, error) {
	target, err := os.Stat(abs)
	if err != nil {
		return nil, nil, err
	}
	if target.IsDir() {
		return nil, nil, FSError{Code: CodeIsDirectory, Path: abs}
	}
	if !target.Mode().IsRegular() {
		return nil, target, nil
	}
	if target.Size() > MaxReadableFileSize {
		return nil, nil, FSError{Code: CodeTooLarge, Path: fmt.Sprintf("%s (%d bytes)", abs, target.Size())}
	}
	file, err := os.Open(abs)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, nil, FSError{Code: CodeIsDirectory, Path: abs}
	}
	if !info.Mode().IsRegular() {
		return nil, info, nil
	}
	buf, err := io.ReadAll(io.LimitReader(file, MaxReadableFileSize+1))
	if err != nil {
		return nil, nil, err
	}
	if len(buf) > MaxReadableFileSize {
		return nil, nil, FSError{Code: CodeTooLarge, Path: fmt.Sprintf("%s (over %d bytes)", abs, MaxReadableFileSize)}
	}
	return buf, info, nil
}
