package fsops

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const tmpPrefix = ".nexus-tmp-"

// WriteFile implements fs.writeFile per
// `src/shared/protocol/agent/fs.ts`. Atomic via tmp + rename on
// plain files; writes through the link target on symlinks so the link
// itself survives the save. When `expected` is supplied and the on-disk
// state has diverged, returns kind="conflict" with the actual state
// instead of overwriting — matches the existing TS atomicWriteFile.
func (f *FS) WriteFile(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WriteFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.writeFile params must include relPath and content")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.writeFile relPath is required")
	}

	abs, err := f.Resolve(p.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	info, statErr := os.Lstat(abs)
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
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

	stat, err := atomicReplace(abs, p.Content)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	return successResult(stat), nil
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
// new one in place — never a half-written target.
func atomicReplace(abs, content string) (os.FileInfo, error) {
	dir := filepath.Dir(abs)
	base := filepath.Base(abs)
	suffix, err := randomSuffix()
	if err != nil {
		return nil, err
	}
	tmp := filepath.Join(dir, fmt.Sprintf("%s%s.%s", tmpPrefix, base, suffix))

	if err := writeAndSync(tmp, content); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return os.Lstat(abs)
}

// plainWrite truncates and writes through to `abs` directly. Used for the
// symlink fallback where atomic rename would swap the link itself.
func plainWrite(abs, content string) (os.FileInfo, error) {
	if err := writeAndSync(abs, content); err != nil {
		return nil, err
	}
	return os.Lstat(abs)
}

func writeAndSync(abs, content string) error {
	file, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
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
	if errors.Is(err, syscall.ENOSPC) {
		return FSError{Code: CodeNoSpace, Path: abs}
	}
	if errors.Is(err, syscall.EXDEV) {
		return FSError{Code: CodeCrossDevice, Path: abs}
	}
	return mapPathError(err, abs)
}
