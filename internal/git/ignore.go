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
	pattern, err := literalIgnorePattern(params.RelPath)
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
	mode := os.FileMode(0o644)
	info, err := os.Stat(targetPath)
	if err == nil {
		mode = info.Mode()
	} else if !errors.Is(err, iofs.ErrNotExist) {
		return err
	}

	tmpPath := targetPath + "." + time.Now().UTC().Format("20060102150405.000000000") + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer os.Remove(tmpPath)
	_, writeErr := file.WriteString(content)
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if info != nil {
		if err := os.Chmod(tmpPath, mode); err != nil {
			return err
		}
	}
	return os.Rename(tmpPath, targetPath)
}

func containsIgnorePattern(content string, pattern string) bool {
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSuffix(line, "\r") == pattern {
			return true
		}
	}
	return false
}

func literalIgnorePattern(relPath string) (string, error) {
	path, err := normalizeRelPath(relPath)
	if err != nil || strings.ContainsAny(path, "\r\n") {
		return "", proto.ProtocolError("git.addToGitignore requires a repository-relative path on one line")
	}

	var pattern strings.Builder
	pattern.WriteByte('/')
	for _, r := range path {
		if strings.ContainsRune(`\*?[] `, r) {
			pattern.WriteByte('\\')
		}
		pattern.WriteRune(r)
	}
	return pattern.String(), nil
}
