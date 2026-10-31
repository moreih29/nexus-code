package fs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const tmpPrefix = ".nexus-tmp-"

// WriteFile implements fs.writeFile per
// `src/shared/protocol/agent/fs.ts`. Atomic via tmp + rename on
// plain files; writes through the link target on symlinks so the link
// itself survives the save. When `expected` is supplied and the on-disk
// state has diverged, returns kind="conflict" with the actual state
// instead of overwriting.
func (s *Service) WriteFile(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WriteFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.writeFile params must include relPath and content")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.writeFile relPath is required")
	}
	if len([]byte(p.Content)) > MaxReadableFileSize {
		return nil, FSError{Code: CodeTooLarge, Path: fmt.Sprintf("%s (%d bytes)", p.RelPath, len([]byte(p.Content)))}
	}

	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	info, statErr := os.Lstat(abs)
	if statErr != nil && !errors.Is(statErr, iofs.ErrNotExist) {
		return nil, mapWriteError(statErr, abs)
	}

	if p.Expected != nil {
		if actual, conflict := expectedConflict(p.Expected, info); conflict {
			return WriteFileResult{Kind: "conflict", Actual: actual}, nil
		}
	} else if info != nil && info.IsDir() {
		// Without an expectation we still refuse to clobber a directory
		// — the atomic rename would silently replace it with a regular
		// file, which is never the user's intent.
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
	}

	if info != nil && info.Mode()&os.ModeSymlink != 0 {
		// Resolve through the link and write at the target so the link
		// itself survives the save. The atomic-rename path would swap
		// the link for a regular file.
		target, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return nil, mapWriteError(err, abs)
		}
		stat, err := plainWrite(target, p.Content)
		if err != nil {
			return nil, mapWriteError(err, abs)
		}
		return successResult(stat), nil
	}

	if info != nil && info.Mode().IsRegular() && needsInPlaceWrite(abs, info) {
		stat, err := plainWrite(abs, p.Content)
		if err != nil {
			return nil, mapWriteError(err, abs)
		}
		return successResult(stat), nil
	}

	stat, err := atomicReplace(abs, p.Content, info)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	return successResult(stat), nil
}

// CreateFile implements fs.createFile with O_EXCL semantics.
func (s *Service) CreateFile(ctx context.Context, raw json.RawMessage) (any, error) {
	var p CreateFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.createFile params must include relPath")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.createFile relPath is required")
	}
	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(abs, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	if err := file.Close(); err != nil {
		return nil, mapWriteError(err, abs)
	}
	return struct{}{}, nil
}

// Mkdir implements fs.mkdir. Recursive creation is explicit so the renderer can
// distinguish "missing parent" mistakes from intentional multi-level creates.
func (s *Service) Mkdir(ctx context.Context, raw json.RawMessage) (any, error) {
	var p MkdirParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.mkdir params must include relPath")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.mkdir relPath is required")
	}
	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p.Recursive {
		err = os.MkdirAll(abs, 0o755)
	} else {
		err = os.Mkdir(abs, 0o755)
	}
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	return struct{}{}, nil
}

// Unlink implements fs.unlink. It removes files and symlink entries only;
// directories are refused so callers must opt into fs.rmdir or a higher-level
// recursive delete flow.
func (s *Service) Unlink(ctx context.Context, raw json.RawMessage) (any, error) {
	var p UnlinkParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.unlink params must include relPath")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.unlink relPath is required")
	}
	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	if info.IsDir() {
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
	}
	if err := os.Remove(abs); err != nil {
		return nil, mapWriteError(err, abs)
	}
	return struct{}{}, nil
}

// Rmdir implements fs.rmdir. It removes empty directories only; files and
// symlink entries are refused so a stale caller cannot delete a file by routing
// it through the directory removal method.
func (s *Service) Rmdir(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RmdirParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.rmdir params must include relPath")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.rmdir relPath is required")
	}
	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	if !info.IsDir() {
		return nil, FSError{Code: CodeNotDirectory, Path: abs}
	}
	if err := os.Remove(abs); err != nil {
		return nil, mapWriteError(err, abs)
	}
	return struct{}{}, nil
}

// renamePath is a narrow test seam for exercising platform-specific rename
// failures such as EXDEV without requiring a second mounted filesystem.
var renamePath = os.Rename

// Rename implements fs.rename within the workspace. It refuses silent
// replacement by checking the target before calling os.Rename.
func (s *Service) Rename(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RenameParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.rename params must include fromRelPath and toRelPath")
	}
	if p.FromRelPath == "" || p.ToRelPath == "" {
		return nil, proto.ProtocolError("fs.rename fromRelPath and toRelPath are required")
	}
	fromAbs, err := s.Resolve(p.FromRelPath)
	if err != nil {
		return nil, err
	}
	toAbs, err := s.Resolve(p.ToRelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	backup := ""
	if toInfo, err := os.Lstat(toAbs); err == nil {
		fromInfo, err := os.Lstat(fromAbs)
		if err != nil {
			return nil, mapWriteError(err, fromAbs)
		}
		// The same entry under another spelling (a case-only rename on a
		// case-insensitive volume, as Windows and macOS have) is renamed in
		// place, neither refused as taken nor moved aside. Another name of
		// the same file, a hard link, is another entry.
		sameEntry := os.SameFile(fromInfo, toInfo) && strings.EqualFold(fromAbs, toAbs)
		if !sameEntry {
			if !p.Overwrite {
				return nil, FSError{Code: CodeAlreadyExists, Path: toAbs}
			}
			if backup, err = moveAside(toAbs); err != nil {
				return nil, mapWriteError(err, toAbs)
			}
		}
	} else if !errors.Is(err, iofs.ErrNotExist) {
		return nil, mapWriteError(err, toAbs)
	}
	if err := renamePath(fromAbs, toAbs); err != nil {
		restoreAside(backup, toAbs)
		return nil, mapWriteError(err, fromAbs)
	}
	if err := discardAside(backup); err != nil {
		return nil, mapWriteError(err, backup)
	}
	return struct{}{}, nil
}

// moveAside renames the entry at abs to a unique hidden sibling so an
// overwriting rename or copy can take its place without deleting it first.
// The caller puts it back with restoreAside if the operation fails, or
// deletes it with discardAside once the replacement is in place, so a
// missing source or a cross-device move no longer costs the destination.
func moveAside(abs string) (string, error) {
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	backup := filepath.Join(filepath.Dir(abs), fmt.Sprintf("%s%s.%s", tmpPrefix, filepath.Base(abs), suffix))
	if err := os.Rename(abs, backup); err != nil {
		return "", err
	}
	return backup, nil
}

// restoreAside moves a moveAside backup back to abs, clearing anything a
// failed operation left there first. A no-op when backup is empty.
func restoreAside(backup, abs string) {
	if backup == "" {
		return
	}
	_ = os.RemoveAll(abs)
	_ = os.Rename(backup, abs)
}

// discardAside deletes a moveAside backup. A no-op when backup is empty.
func discardAside(backup string) error {
	if backup == "" {
		return nil
	}
	return os.RemoveAll(backup)
}

// RemoveAll implements fs.removeAll. It removes the directory tree at relPath
// recursively. Files and symlink entries are refused so a stale caller cannot
// delete a file by routing it through the recursive directory removal method.
func (s *Service) RemoveAll(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RemoveAllParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.removeAll params must include relPath")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.removeAll relPath is required")
	}
	abs, err := s.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		// Idempotent: a missing path is treated as success. Matches the
		// stdlib's `os.RemoveAll` contract and lets the renderer call
		// removeAll without first asking "does this still exist?" — which
		// would otherwise log a noisy ipcMain error every time a stale
		// row's delete races with a refresh.
		if errors.Is(err, iofs.ErrNotExist) {
			return struct{}{}, nil
		}
		return nil, mapWriteError(err, abs)
	}
	if !info.IsDir() {
		return nil, FSError{Code: CodeNotDirectory, Path: abs}
	}
	if err := os.RemoveAll(abs); err != nil {
		return nil, mapWriteError(err, abs)
	}
	return struct{}{}, nil
}

// expectedConflict compares the caller's expectation against the actual
// on-disk state. Returns (actualState, true) when the wire shape must
// carry the divergent state back; (nil, false) when the write may proceed.
func expectedConflict(expected *ExpectedFileState, info os.FileInfo) (*ExpectedFileState, bool) {
	if !expected.Exists {
		if info == nil {
			return nil, false
		}
		return statToExpected(info), true
	}
	if info == nil {
		return &ExpectedFileState{Exists: false}, true
	}
	if info.IsDir() {
		return statToExpected(info), true
	}
	mtime := formatMTime(info.ModTime())
	size := info.Size()
	if expected.MTime == nil || expected.Size == nil ||
		*expected.MTime != mtime || *expected.Size != size {
		return statToExpected(info), true
	}
	return nil, false
}

func statToExpected(info os.FileInfo) *ExpectedFileState {
	mtime := formatMTime(info.ModTime())
	size := info.Size()
	return &ExpectedFileState{Exists: true, MTime: &mtime, Size: &size}
}

func successResult(info os.FileInfo) WriteFileResult {
	mtime := formatMTime(info.ModTime())
	size := info.Size()
	return WriteFileResult{Kind: "ok", MTime: &mtime, Size: &size}
}

// atomicReplace writes `content` to a sibling tmp file, fsyncs it, then
// renames it over `abs`. POSIX rename-within-same-filesystem is atomic,
// so a crash mid-write leaves either the previous file intact or the
// new one in place — never a half-written target. `existing` is the target's
// Lstat (nil when it does not exist yet); its mode and group carry over to
// the replacement so a save does not turn 0600 into 0644 or drop an exec bit.
func atomicReplace(abs, content string, existing os.FileInfo) (os.FileInfo, error) {
	dir := filepath.Dir(abs)
	base := filepath.Base(abs)
	suffix, err := randomSuffix()
	if err != nil {
		return nil, err
	}
	tmp := filepath.Join(dir, fmt.Sprintf("%s%s.%s", tmpPrefix, base, suffix))

	perm := os.FileMode(0o644)
	if existing != nil {
		perm = existing.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
	}
	if err := writeAndSync(tmp, content, perm); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if existing != nil {
		// OpenFile's mode is filtered by the umask, so set it exactly.
		if err := os.Chmod(tmp, perm); err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
		keepGroup(tmp, existing)
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return os.Lstat(abs)
}

// plainWrite truncates and writes through to `abs` directly. Used for the
// symlink fallback where atomic rename would swap the link itself, and for
// files whose inode must survive (see needsInPlaceWrite).
func plainWrite(abs, content string) (os.FileInfo, error) {
	if err := writeAndSync(abs, content, 0o644); err != nil {
		return nil, err
	}
	return os.Lstat(abs)
}

func writeAndSync(abs, content string, perm os.FileMode) error {
	file, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.WriteString(content); err != nil {
		return err
	}
	return file.Sync()
}

func randomSuffix() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// mapWriteError extends mapPathError with codes that only fire on write
// paths (ENOSPC, cross-device rename). Reuses the read-side mapping for
// everything else so the error vocabulary stays consistent across methods.
func mapWriteError(err error, abs string) error {
	if isNoSpace(err) {
		return FSError{Code: CodeNoSpace, Path: abs}
	}
	if isCrossDevice(err) {
		return FSError{Code: CodeCrossDevice, Path: abs}
	}
	// Ahead of mapPathError: Windows reports a non-empty directory as
	// fs.ErrExist too.
	if isNotEmpty(err) {
		return FSError{Code: CodeNotEmpty, Path: abs}
	}
	return mapPathError(err, abs)
}
