package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Conflict RPC types
// ---------------------------------------------------------------------------

// ConflictMarkResolvedParams carries the parameters for git.conflict.markResolved.
type ConflictMarkResolvedParams struct {
	Cwd      string   `json:"cwd"`
	RelPaths []string `json:"relPaths"`
}

// ConflictMarkResolvedResult is the result of git.conflict.markResolved.
type ConflictMarkResolvedResult struct {
	RemainingConflicts int `json:"remainingConflicts"`
}

// ---------------------------------------------------------------------------
// ConflictMarkResolved — git.conflict.markResolved
// ---------------------------------------------------------------------------

// ConflictMarkResolved validates that every requested path is currently
// conflicted, stages the files (git add --), and returns the remaining
// conflict count after the staging.
func (s *Service) ConflictMarkResolved(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ConflictMarkResolvedParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.conflict.markResolved params must include cwd and relPaths")
	}
	if len(p.RelPaths) == 0 {
		return nil, proto.ProtocolError("git.conflict.markResolved relPaths must not be empty")
	}

	// Read current status to collect conflicted paths.
	status, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}

	// Resolve the repo top-level for path normalization.
	topLevel, err := s.resolveTopLevel(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}

	// Normalize requested paths relative to repo root.
	normalized, err := normalizeConflictPaths(topLevel, p.RelPaths)
	if err != nil {
		return nil, err
	}

	// Collect currently-conflicted paths from merge entries.
	conflicted := conflictedPathSet(status)
	for _, relPath := range normalized {
		if !conflicted[relPath] {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  "path-not-conflicted: Path is not conflicted: " + relPath,
			}
		}
	}

	// Stage the resolved paths.
	addArgs := append([]string{"add", "--"}, normalized...)
	_, stderr, code, runErr := s.runWorkflowGit(ctx, p.Cwd, addArgs)
	if runErr != nil {
		return nil, runErr
	}
	if code != 0 {
		return nil, workflowGitError(addArgs, stderr, code)
	}

	// Re-read status to count remaining conflicts.
	refreshed, err := s.statusCore(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	return ConflictMarkResolvedResult{RemainingConflicts: len(refreshed.Merge)}, nil
}

// resolveTopLevel asks git for the top-level directory from cwd.
func (s *Service) resolveTopLevel(ctx context.Context, cwd string) (string, error) {
	out, err := s.statusGitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// normalizeConflictPaths normalizes each relPath relative to the repo root,
// rejecting absolute paths and paths outside the repo.
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

// normalizeConflictPath normalizes one path relative to the repo root.
func normalizeConflictPath(topLevel, relPath string) (string, error) {
	trimmed := strings.TrimSpace(relPath)
	if trimmed == "" || filepath.IsAbs(trimmed) {
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
	// Return POSIX-style path (forward slashes).
	return filepath.ToSlash(rel), nil
}

// conflictedPathSet collects all currently-conflicted repo-relative paths
// from the merge status entries.
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
