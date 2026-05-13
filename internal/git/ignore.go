package git

import (
	"context"
	"encoding/json"
	"errors"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type AddToGitignoreParams struct {
	RepoRoot string `json:"repoRoot"`
	RelPath  string `json:"relPath"`
}

type AddToGitignoreResult struct {
	Added          bool `json:"added"`
	AlreadyIgnored bool `json:"alreadyIgnored"`
}

func (s *Service) AddToGitignore(ctx context.Context, raw json.RawMessage) (any, error) {
	var params AddToGitignoreParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, proto.ProtocolError("git.addToGitignore params must include repoRoot and relPath")
	}
	repoRoot, err := s.resolveCwd(ctx, params.RepoRoot)
	if err != nil {
		return nil, err
	}
	pattern, err := normalizeIgnorePattern(params.RelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	ignorePath := filepath.Join(repoRoot, ".gitignore")
	current, err := readExistingGitignore(ignorePath)
	if err != nil {
		return nil, err
	}
	if containsIgnorePattern(current, pattern) {
		return AddToGitignoreResult{Added: false, AlreadyIgnored: true}, nil
	}
	prefix := current
	if prefix != "" && !strings.HasSuffix(prefix, "\n") {
		prefix += "\n"
	}
	if err := atomicWriteText(ignorePath, prefix+pattern+"\n"); err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}
	return AddToGitignoreResult{Added: true, AlreadyIgnored: false}, nil
}

func readExistingGitignore(ignorePath string) (string, error) {
	buf, err := os.ReadFile(ignorePath)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return string(buf), nil
}

func atomicWriteText(targetPath string, content string) error {
	tmpPath := targetPath + "." + time.Now().UTC().Format("20060102150405.000000000") + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func containsIgnorePattern(content string, pattern string) bool {
	for _, line := range strings.Split(content, "\n") {
		if normalizeExistingPatternLine(strings.TrimSuffix(line, "\r")) == pattern {
			return true
		}
	}
	return false
}

func normalizeIgnorePattern(relPath string) (string, error) {
	slashPath := strings.TrimPrefix(strings.ReplaceAll(relPath, "\\", "/"), "./")
	parts := strings.Split(slashPath, "/")
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			cleaned = append(cleaned, part)
		}
	}
	normalized := strings.Join(cleaned, "/")
	if normalized == "" ||
		strings.HasPrefix(slashPath, "/") ||
		windowsAbs.MatchString(slashPath) ||
		strings.Contains(slashPath, "\x00") ||
		containsPart(cleaned, "..") {
		return "", proto.ProtocolError("git.addToGitignore relPath must stay inside the repository")
	}
	return normalized, nil
}

func normalizeExistingPatternLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
		return ""
	}
	trimmed = strings.TrimPrefix(trimmed, "/")
	trimmed = strings.TrimPrefix(trimmed, "./")
	return trimmed
}
