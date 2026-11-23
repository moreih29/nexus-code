package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type ConflictMarkResolvedParams struct {
	Cwd      string   `json:"cwd"`
	RelPaths []string `json:"relPaths"`
}

type ConflictMarkResolvedResult struct {
	RemainingConflicts int `json:"remainingConflicts"`
}

func (s *Service) ConflictMarkResolved(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ConflictMarkResolvedParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.conflict.markResolved params must include cwd and relPaths")
	}
	if len(p.RelPaths) == 0 {
		return nil, proto.ProtocolError("git.conflict.markResolved relPaths must not be empty")
	}

	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}

	topLevel, err := s.resolveTopLevel(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}

	normalized, err := normalizeConflictPaths(topLevel, p.RelPaths)
	if err != nil {
		return nil, err
	}

	conflicted := conflictedPathSet(status)
	for _, relPath := range normalized {
		if !conflicted[relPath] {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  "path-not-conflicted: Path is not conflicted: " + relPath,
			}
		}
	}

	addArgs := append([]string{"add", "--"}, normalized...)
	_, stderr, code, runErr := s.captureEnv(ctx, p.Cwd, addArgs, literalPathspecs, false)
	if runErr != nil {
		return nil, runErr
	}
	if code != 0 {
		return nil, workflowGitError(addArgs, stderr, code)
	}

	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	return ConflictMarkResolvedResult{RemainingConflicts: len(refreshed.Merge)}, nil
}

func (s *Service) resolveTopLevel(ctx context.Context, cwd string) (string, error) {
	out, err := s.statusGitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func normalizeConflictPaths(topLevel string, relPaths []string) ([]string, error) {
	result := make([]string, 0, len(relPaths))
	for _, relPath := range relPaths {
		normalized, err := normalizeConflictPath(topLevel, relPath)
		if err != nil {
			return nil, err
		}
		result = append(result, normalized)
	}
	return result, nil
}

func normalizeConflictPath(topLevel, relPath string) (string, error) {
	trimmed := strings.TrimSpace(relPath)
	if trimmed == "" || filepath.IsAbs(trimmed) || strings.HasPrefix(filepath.ToSlash(trimmed), "/") ||
		filepath.VolumeName(trimmed) != "" {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  "path-not-in-repo: Path is not inside the repository: " + relPath,
		}
	}
	abs := filepath.Join(topLevel, filepath.FromSlash(trimmed))
	rel, err := filepath.Rel(topLevel, abs)
	if err != nil || rel == "" || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  "path-not-in-repo: Path is not inside the repository: " + relPath,
		}
	}
	return filepath.ToSlash(rel), nil
}

func conflictedPathSet(status GitStatus) map[string]bool {
	set := make(map[string]bool, len(status.Merge)*2)
	for _, entry := range status.Merge {
		set[entry.RelPath] = true
		if entry.OldRelPath != nil {
			set[*entry.OldRelPath] = true
		}
	}
	return set
}
