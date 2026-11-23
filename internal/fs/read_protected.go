package fs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

func (s *Service) protectedPath(raw json.RawMessage) (string, error) {
	abs, err := s.resolve(raw)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(s.root, abs)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.protectedRoot, rel), nil
}

func (s *Service) ReaddirNoLinks(ctx context.Context, raw json.RawMessage) (any, error) {
	var target struct {
		AbsolutePath string `json:"absolutePath"`
	}
	if err := json.Unmarshal(raw, &target); err != nil {
		return nil, err
	}
	var abs string
	var err error
	if target.AbsolutePath != "" {
		abs, err = parseAbsolutePath(raw)
	} else {
		abs, err = s.protectedPath(raw)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	dir, err := openProtectedDirectory(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		if _, hidden := hiddenNames[entry.Name()]; hidden {
			continue
		}
		row := DirEntry{Name: entry.Name(), Type: entryType(entry)}
		if target.AbsolutePath != "" && row.Type == "file" {
			row.Size = protectedEntrySize(dir, row.Name)
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func openProtectedRegular(ctx context.Context, abs string) (*os.File, os.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	file, err := openPreviewFile(abs)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err == nil {
		err = previewRegular(info, abs)
	}
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, info, nil
}

func (s *Service) ReadFileNoLinks(ctx context.Context, raw json.RawMessage) (any, error) {
	var opts struct {
		Binary bool `json:"binary"`
	}
	if err := json.Unmarshal(raw, &opts); err != nil {
		return nil, err
	}
	abs, err := s.protectedPath(raw)
	if err != nil {
		return nil, err
	}
	file, info, err := openProtectedRegular(ctx, abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			if opts.Binary {
				return ReadBinaryResult{Kind: "missing", Reason: "not-found"}, nil
			}
			return ReadFileResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	defer file.Close()
	if info.Size() > MaxReadableFileSize {
		return nil, FSError{Code: CodeTooLarge, Path: abs}
	}
	buf, err := io.ReadAll(io.LimitReader(file, MaxReadableFileSize+1))
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	if len(buf) > MaxReadableFileSize {
		return nil, FSError{Code: CodeTooLarge, Path: abs}
	}
	if opts.Binary {
		return ReadBinaryResult{
			Kind: "ok", Base64: base64.StdEncoding.EncodeToString(buf),
			Size: info.Size(), MTime: formatMTime(info.ModTime()),
		}, nil
	}
	return buildFileContent(buf, info), nil
}

func (s *Service) ReadRangeNoLinks(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.protectedPath(raw)
	if err != nil {
		return nil, err
	}
	r, err := parseReadRange(raw)
	if err != nil {
		return nil, err
	}
	file, info, err := openProtectedRegular(ctx, abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ReadBinaryResult{Kind: "missing", Reason: "not-found"}, nil
		}
		return nil, mapPathError(err, abs)
	}
	defer file.Close()
	buf := make([]byte, max(0, min(r.Length, info.Size()-r.Offset)))
	n, err := file.ReadAt(buf, r.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, mapPathError(err, abs)
	}
	return ReadBinaryResult{
		Kind: "ok", Base64: base64.StdEncoding.EncodeToString(buf[:n]),
		Size: info.Size(), MTime: formatMTime(info.ModTime()),
	}, nil
}
