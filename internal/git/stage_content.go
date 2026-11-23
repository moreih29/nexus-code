package git

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type StageContentParams struct {
	Cwd     string `json:"cwd,omitempty"`
	RelPath string `json:"relPath"`
	Content string `json:"content"`
}

const defaultFileMode = "100644"

func (s *Service) StageContent(ctx context.Context, raw json.RawMessage) (any, error) {
	var p StageContentParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.stageContent params must include relPath and content")
	}
	relPath, err := normalizeRelPath(p.RelPath)
	if err != nil {
		return nil, proto.ProtocolError("git.stageContent relPath must stay inside the repository")
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.stageContent cwd must not contain NUL")
	}

	cwd, err := s.resolveCwd(ctx, p.Cwd)
	if err != nil {
		return nil, err
	}
	topLevel, err := gitTopLevel(ctx, cwd)
	if err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git.stageContent cwd is not inside a repository"}
	}

	mode, err := s.stagedFileMode(ctx, topLevel, relPath)
	if err != nil {
		return nil, err
	}
	hash, err := s.writeBlob(ctx, topLevel, relPath, p.Content)
	if err != nil {
		return nil, err
	}

	args := []string{"update-index", "--add", "--cacheinfo", mode + "," + hash + "," + relPath}
	_, stderr, code, err := s.capture(ctx, topLevel, args, false)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, gitError(args, stderr, code)
	}
	return nil, nil
}

func (s *Service) stagedFileMode(ctx context.Context, topLevel string, relPath string) (string, error) {
	indexArgs := []string{"ls-files", "--stage", "-z", "--", relPath}
	out, stderr, code, err := s.captureEnv(ctx, topLevel, indexArgs, literalPathspecs, false)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", gitError(indexArgs, stderr, code)
	}
	if mode, staged := parseEntryMode(out, true); staged {
		return checkStageableMode(mode)
	}

	treeArgs := []string{"ls-tree", "-z", "HEAD", "--", relPath}
	out, _, code, err = s.captureEnv(ctx, topLevel, treeArgs, literalPathspecs, false)
	if err != nil {
		return "", err
	}
	if code == 0 {
		if mode, found := parseEntryMode(out, false); found {
			return checkStageableMode(mode)
		}
	}
	return defaultFileMode, nil
}

func parseEntryMode(out string, index bool) (mode string, found bool) {
	record, _, _ := strings.Cut(out, "\x00")
	meta, _, ok := strings.Cut(record, "\t")
	if !ok {
		return "", false
	}
	fields := strings.Fields(meta)
	if len(fields) < 3 {
		return "", false
	}
	if index && fields[2] != "0" {
		return "conflict", true
	}
	return fields[0], true
}

func checkStageableMode(mode string) (string, error) {
	switch mode {
	case "100644", "100755":
		return mode, nil
	case "conflict":
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "Cannot stage part of a file with merge conflicts"}
	default:
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "Only regular files can be staged in part"}
	}
}

func (s *Service) writeBlob(ctx context.Context, topLevel string, relPath string, content string) (string, error) {
	args := []string{"hash-object", "-w", "--stdin", "--path=" + relPath}
	cmd, err := s.command(ctx, args, topLevel, nil, false)
	if err != nil {
		return "", err
	}
	cmd.Stdin = strings.NewReader(content)
	stdout, stderr, code, fatal := runCapturedCommand(ctx, cmd)
	if fatal != nil {
		return "", fatal
	}
	if code != 0 {
		return "", gitError(args, stderr, code)
	}
	hash := strings.TrimSpace(stdout)
	if hash == "" {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git hash-object returned no object id"}
	}
	return hash, nil
}
