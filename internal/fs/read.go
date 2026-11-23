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

var hiddenNames = map[string]struct{}{
	".git": {}, ".DS_Store": {},
}

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

func (s *Service) ReadFile(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	return readFileAt(ctx, abs)
}

func (s *Service) ReadAbsolute(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := parseAbsolutePath(raw)
	if err != nil {
		return nil, err
	}
	return readFileAt(ctx, abs)
}

func (s *Service) ReadAbsoluteBinary(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := parseAbsolutePath(raw)
	if err != nil {
		return nil, err
	}
	return readBinaryAt(ctx, abs)
}

func (s *Service) ReadBinary(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return nil, err
	}
	return readBinaryAt(ctx, abs)
}

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
