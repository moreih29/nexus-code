package git

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	changeStatsUntrackedLimit = 500
	changeStatsFileLimit      = 8 << 20
	binarySniffBytes          = 8000
)

type ChangeStatsParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Base string `json:"base,omitempty"`
}

type FileLineStats struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
}

type ChangeStats struct {
	Files  []FileLineStats `json:"files"`
	Ahead  *int            `json:"ahead,omitempty"`
	Behind *int            `json:"behind,omitempty"`
}

func (s *Service) ChangeStats(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseChangeStatsParams(raw)
	if err != nil {
		return nil, err
	}
	files, err := s.trackedLineStats(ctx, params.Cwd)
	if err != nil {
		return nil, err
	}
	untracked, err := s.untrackedLineStats(ctx, params.Cwd)
	if err != nil {
		return nil, err
	}
	stats := ChangeStats{Files: append(files, untracked...)}
	if params.Base != "" {
		stats.Ahead, stats.Behind = s.aheadBehind(ctx, params.Cwd, params.Base)
	}
	return stats, nil
}

func parseChangeStatsParams(raw json.RawMessage) (ChangeStatsParams, error) {
	var params ChangeStatsParams
	if len(raw) != 0 && json.Unmarshal(raw, &params) != nil {
		return params, proto.ProtocolError("git.changeStats params must be an object")
	}
	params.Base = strings.TrimSpace(params.Base)
	if strings.Contains(params.Base, "\x00") || strings.Contains(params.Cwd, "\x00") {
		return params, proto.ProtocolError("git.changeStats params must not contain NUL")
	}
	if optionLike(params.Base) {
		return params, proto.ProtocolError("git.changeStats base must not start with -")
	}
	return params, nil
}

func (s *Service) trackedLineStats(ctx context.Context, cwd string) ([]FileLineStats, error) {
	against := "HEAD"
	if _, err := s.statusGitOutput(ctx, cwd, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		empty, err := s.statusGitOutput(ctx, cwd, "hash-object", "-t", "tree", "--stdin")
		if err != nil {
			return nil, err
		}
		against = strings.TrimSpace(string(empty))
	}
	out, err := s.statusGitOutput(ctx, cwd, "diff", "--numstat", "-z", against, "--")
	if err != nil {
		return nil, err
	}
	return parseNumstatZ(out), nil
}

func parseNumstatZ(out []byte) []FileLineStats {
	fields := strings.Split(string(out), "\x00")
	files := []FileLineStats{}
	for i := 0; i < len(fields); i++ {
		parts := strings.SplitN(fields[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if path == "" {
			if i+2 >= len(fields) {
				break
			}
			path = fields[i+2]
			i += 2
		}
		added, addedErr := strconv.Atoi(parts[0])
		deleted, deletedErr := strconv.Atoi(parts[1])
		if addedErr != nil || deletedErr != nil {
			files = append(files, FileLineStats{Path: path, Binary: true})
			continue
		}
		files = append(files, FileLineStats{Path: path, Added: added, Deleted: deleted})
	}
	return files
}

func (s *Service) untrackedLineStats(ctx context.Context, cwd string) ([]FileLineStats, error) {
	out, err := s.statusGitOutput(ctx, cwd, "ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/")
	if err != nil {
		return nil, err
	}
	cdup, err := s.statusGitOutput(ctx, cwd, "rev-parse", "--show-cdup")
	if err != nil {
		return nil, err
	}
	dir, err := s.resolveCwd(ctx, cwd)
	if err != nil {
		return nil, err
	}
	top := filepath.Join(dir, strings.TrimSpace(string(cdup)))
	files := []FileLineStats{}
	for _, path := range strings.Split(string(out), "\x00") {
		if path == "" {
			continue
		}
		if len(files) == changeStatsUntrackedLimit {
			break
		}
		lines, binary, ok := countFileLines(filepath.Join(top, filepath.FromSlash(path)))
		if !ok {
			continue
		}
		files = append(files, FileLineStats{Path: path, Added: lines, Binary: binary})
	}
	return files, nil
}

func countFileLines(path string) (lines int, binary bool, ok bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > changeStatsFileLimit {
		return 0, false, false
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, false, false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, changeStatsFileLimit+1))
	if err != nil || len(data) > changeStatsFileLimit {
		return 0, false, false
	}
	if bytes.IndexByte(data[:min(len(data), binarySniffBytes)], 0) >= 0 {
		return 0, true, true
	}
	lines = bytes.Count(data, []byte{'\n'})
	if len(data) > 0 && data[len(data)-1] != '\n' {
		lines++
	}
	return lines, false, true
}

func (s *Service) aheadBehind(ctx context.Context, cwd, base string) (ahead, behind *int) {
	out, err := s.statusGitOutput(ctx, cwd, "rev-list", "--left-right", "--count", base+"...HEAD", "--")
	if err != nil {
		return nil, nil
	}
	counts := strings.Fields(string(out))
	if len(counts) != 2 {
		return nil, nil
	}
	left, leftErr := strconv.Atoi(counts[0])
	right, rightErr := strconv.Atoi(counts[1])
	if leftErr != nil || rightErr != nil {
		return nil, nil
	}
	return &right, &left
}
