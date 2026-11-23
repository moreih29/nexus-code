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

func (s *Service) WriteFile(ctx context.Context, raw json.RawMessage) (any, error) {
	var p WriteFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.writeFile params must include relPath and content")
	}
	if p.RelPath == "" {
		return nil, proto.ProtocolError("fs.writeFile relPath is required")
	}
	if p.Bytes != nil {
		if p.Content != "" {
			return nil, proto.ProtocolError("fs.writeFile takes content or bytes, not both")
		}
		p.Content = string(p.Bytes)
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

	if info != nil && info.Mode()&os.ModeSymlink != 0 &&
		(p.Expected == nil || p.Expected.Exists) {
		return writeLinkedFile(abs, p.Content, p.Expected)
	}

	if p.Expected != nil {
		if actual, conflict := expectedConflict(p.Expected, info); conflict {
			return WriteFileResult{Kind: "conflict", Actual: actual}, nil
		}
	} else if info != nil && info.IsDir() {
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
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

func writeLinkedFile(abs, content string, expected *ExpectedFileState) (any, error) {
	target, err := os.Stat(abs)
	if err != nil {
		if expected != nil && errors.Is(err, iofs.ErrNotExist) {
			return WriteFileResult{Kind: "conflict", Actual: &ExpectedFileState{}}, nil
		}
		return nil, mapWriteError(err, abs)
	}
	if expected != nil {
		if actual, conflict := expectedConflict(expected, target); conflict {
			return WriteFileResult{Kind: "conflict", Actual: actual}, nil
		}
	}
	if !target.Mode().IsRegular() {
		if target.IsDir() {
			return nil, FSError{Code: CodeIsDirectory, Path: abs}
		}
		return nil, proto.ProtocolError("fs.writeFile target must be a regular file")
	}
	file, err := os.OpenFile(abs, os.O_WRONLY, 0)
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	if !os.SameFile(info, target) {
		return WriteFileResult{Kind: "conflict", Actual: statToExpected(info)}, nil
	}
	if expected != nil {
		if actual, conflict := expectedConflict(expected, info); conflict {
			return WriteFileResult{Kind: "conflict", Actual: actual}, nil
		}
	}
	if err := file.Truncate(0); err != nil {
		return nil, mapWriteError(err, abs)
	}
	if _, err := file.WriteString(content); err != nil {
		return nil, mapWriteError(err, abs)
	}
	if err := file.Sync(); err != nil {
		return nil, mapWriteError(err, abs)
	}
	info, err = file.Stat()
	if err != nil {
		return nil, mapWriteError(err, abs)
	}
	return successResult(info), nil
}

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

var renamePath = os.Rename

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

func restoreAside(backup, abs string) {
	if backup == "" {
		return
	}
	_ = os.RemoveAll(abs)
	_ = os.Rename(backup, abs)
}

func discardAside(backup string) error {
	if backup == "" {
		return nil
	}
	return os.RemoveAll(backup)
}

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

func atomicReplace(abs, content string, existing os.FileInfo) (os.FileInfo, error) {
	dir := filepath.Dir(abs)
	suffix, err := randomSuffix()
	if err != nil {
		return nil, err
	}
	tmp := filepath.Join(dir, tmpPrefix+suffix)

	perm := os.FileMode(0o644)
	if existing != nil {
		perm = existing.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
	}
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	writeErr := writeAndSync(file, content)
	if closeErr := file.Close(); writeErr != nil || closeErr != nil {
		return nil, errors.Join(writeErr, closeErr)
	}
	if existing != nil {
		if err := os.Chmod(tmp, perm); err != nil {
			return nil, err
		}
		keepGroup(tmp, existing)
	}
	if err := os.Rename(tmp, abs); err != nil {
		return nil, err
	}
	return os.Lstat(abs)
}

func plainWrite(abs, content string) (os.FileInfo, error) {
	file, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	writeErr := writeAndSync(file, content)
	if closeErr := file.Close(); writeErr != nil || closeErr != nil {
		return nil, errors.Join(writeErr, closeErr)
	}
	return os.Lstat(abs)
}

func writeAndSync(file *os.File, content string) error {
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

func mapWriteError(err error, abs string) error {
	if isNoSpace(err) {
		return FSError{Code: CodeNoSpace, Path: abs}
	}
	if isCrossDevice(err) {
		return FSError{Code: CodeCrossDevice, Path: abs}
	}
	if isNotEmpty(err) {
		return FSError{Code: CodeNotEmpty, Path: abs}
	}
	return mapPathError(err, abs)
}
