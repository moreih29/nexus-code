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

// A worktree's uncommitted changes in lines, file by file, and how far its
// branch has gone from another: what a task's detail shows of it.

const (
	// changeStatsUntrackedLimit bounds how many untracked files are read to
	// count their lines; the rest are listed without a count.
	changeStatsUntrackedLimit = 500
	// changeStatsFileLimit is the largest untracked file whose lines are
	// counted.
	changeStatsFileLimit = 8 << 20
	// binarySniffBytes is how much of a file is searched for a NUL byte, as
	// git does, to tell binary from text.
	binarySniffBytes = 8000
)

type ChangeStatsParams struct {
	Cwd string `json:"cwd,omitempty"`
	// Base is the branch the worktree's branch is compared with; none when
	// empty.
	Base string `json:"base,omitempty"`
}

// FileLineStats is one changed file's lines added and deleted against HEAD.
// A binary file has neither.
type FileLineStats struct {
	// Path is relative to the repository's top level, as git.status reports it.
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
}

type ChangeStats struct {
	Files []FileLineStats `json:"files"`
	// Ahead and Behind count the commits HEAD has that Base does not, and
	// the other way round. Both are absent without a Base, or when it does
	// not resolve.
	Ahead  *int `json:"ahead,omitempty"`
	Behind *int `json:"behind,omitempty"`
}

// ChangeStats returns the lines each uncommitted file adds and deletes, staged
// or not, untracked ones included, and HEAD's commits ahead of and behind
// params.Base.
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

// trackedLineStats diffs the working tree, index included, against HEAD, or
// against the empty tree in a repository without commits.
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

// parseNumstatZ reads `git diff --numstat -z`: "added\tdeleted\tpath\0",
// or "added\tdeleted\t\0old\0new\0" for a rename, listed under its new path.
// A binary file's counts are "-".
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
			// A rename: the old path, then the new one.
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

// untrackedLineStats counts the lines of the files git does not track nor
// ignore, each of them added.
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

// countFileLines counts a regular file's lines, a last one without a newline
// included. It reports false for any other file, one too large or one that
// cannot be read.
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

// aheadBehind counts the commits HEAD and base have that the other has not.
// Both are nil when base does not resolve.
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
