package fs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	iofs "io/fs"
	"os"
)

// hiddenNames are directory entries that fs.readdir omits by default.
var hiddenNames = map[string]struct{}{
	".git": {}, "node_modules": {}, "dist": {}, "out": {}, ".DS_Store": {},
	".next": {}, ".turbo": {}, ".cache": {}, ".vscode-test": {},
}

// Readdir lists the entries at relPath, omitting names in hiddenNames.
func (s *Service) Readdir(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
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

// Stat returns Lstat metadata for relPath. Symlinks are reported as symlinks
// and are not followed.
func (s *Service) Stat(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
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

func readFileAt(ctx context.Context, abs string) (any, error) {
	info, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	buf, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	return buildFileContent(buf, info), nil
}
