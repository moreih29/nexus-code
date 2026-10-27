package git

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// git.stageContent — stage given content as one file's index version
// ---------------------------------------------------------------------------

// StageContentParams carries the full content to stage for one path.
type StageContentParams struct {
	Cwd     string `json:"cwd,omitempty"`
	RelPath string `json:"relPath"`
	Content string `json:"content"`
}

// defaultFileMode is the index mode of a path with no index or HEAD entry.
const defaultFileMode = "100644"

// literalPathspecs makes git read a relPath as a path, not a glob or magic.
var literalPathspecs = map[string]string{"GIT_LITERAL_PATHSPECS": "1"}

// StageContent makes content the staged version of relPath without touching
// the working tree. This is how part of a file gets staged, as VSCode does:
// the renderer applies the chosen changes to the index version and hands
// back the result. The entry keeps its index mode (else HEAD's, else a
// regular file's); symlinks, submodules and conflicted paths are refused.
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

	// relPath is relative to the repository root, so run where it resolves.
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

// stagedFileMode returns the mode relPath is staged with, or would be: its
// index entry's, else its HEAD entry's, else a regular file's.
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

	// An unborn HEAD fails here and leaves the default.
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

// parseEntryMode reads the mode of the first NUL-terminated `ls-files --stage`
// or `ls-tree` record. An index entry at a merge stage other than 0 yields
// "conflict".
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

// writeBlob stores content as a blob, through relPath's attributes (line
// ending conversion, clean filters) as `git add` would, and returns its id.
func (s *Service) writeBlob(ctx context.Context, topLevel string, relPath string, content string) (string, error) {
	args := []string{"hash-object", "-w", "--stdin", "--path=" + relPath}
	cmd, err := s.command(ctx, args, topLevel, nil, false)
	if err != nil {
		return "", err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdin = strings.NewReader(content)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", ctxErr
	}
	code, fatal := gitExitCode(runErr)
	if fatal != nil {
		return "", fatal
	}
	if code != 0 {
		return "", gitError(args, stderr.String(), code)
	}
	hash := strings.TrimSpace(stdout.String())
	if hash == "" {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git hash-object returned no object id"}
	}
	return hash, nil
}
