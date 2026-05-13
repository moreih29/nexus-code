package git

import (
	"context"
	"encoding/json"
	"errors"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type MetadataParams struct {
	GitDir        string `json:"gitDir"`
	ConflictCount int    `json:"conflictCount,omitempty"`
}

type MetadataResult struct {
	OperationState map[string]any `json:"operationState"`
	LastFetchedAt  *int64         `json:"lastFetchedAt"`
}

type rebaseProgress struct {
	done  int
	total int
}

// Metadata reads repository marker files that are not exposed by porcelain
// status: in-progress workflow state plus FETCH_HEAD mtime.
func (s *Service) Metadata(ctx context.Context, raw json.RawMessage) (any, error) {
	var params MetadataParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, proto.ProtocolError("git.metadata params must include gitDir")
	}
	gitDir, err := s.resolveGitDir(ctx, params.GitDir)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := readOperationState(gitDir, params.ConflictCount)
	if err != nil {
		return nil, err
	}
	fetched, err := readFetchHeadMtime(gitDir)
	if err != nil {
		return nil, err
	}
	return MetadataResult{OperationState: state, LastFetchedAt: fetched}, nil
}

func (s *Service) resolveGitDir(ctx context.Context, gitDir string) (string, error) {
	if strings.TrimSpace(gitDir) == "" || strings.Contains(gitDir, "\x00") {
		return "", proto.ProtocolError("gitDir is required")
	}
	clean := filepath.Clean(gitDir)
	if !filepath.IsAbs(clean) {
		clean = filepath.Clean(filepath.Join(s.root, clean))
	}
	if isInside(clean, s.root) {
		return clean, nil
	}
	topLevel, err := gitTopLevel(ctx, s.root)
	if err == nil {
		rel, relErr := filepath.Rel(topLevel, clean)
		if relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return clean, nil
		}
	}
	return "", proto.ProtocolError("gitDir must stay inside the workspace or detected repository")
}

func readOperationState(gitDir string, conflictCount int) (map[string]any, error) {
	if conflictCount < 0 {
		conflictCount = 0
	}
	headRef, err := readHeadRef(gitDir)
	if err != nil {
		return nil, err
	}

	mergeHead, err := readTrimmed(filepath.Join(gitDir, "MERGE_HEAD"))
	if err != nil {
		return nil, err
	}
	if mergeHead != nil {
		state := map[string]any{
			"kind":          "merge",
			"headRef":       headRef,
			"mergeRef":      *mergeHead,
			"conflictCount": conflictCount,
		}
		if label := mergeLabelFromMessage(readFirstMessageLineNoErr(filepath.Join(gitDir, "MERGE_MSG"))); label != nil {
			state["mergeLabel"] = *label
		}
		return state, nil
	}

	rebaseMergeDir := filepath.Join(gitDir, "rebase-merge")
	if exists, err := pathExists(rebaseMergeDir); err != nil {
		return nil, err
	} else if exists {
		progress := readRebaseProgressNoErr(rebaseMergeDir, "msgnum", "end")
		state := map[string]any{
			"kind":          "rebase",
			"variant":       "merge",
			"headRef":       readRebaseHeadRefNoErr(rebaseMergeDir, headRef),
			"ontoRef":       stringPtrValue(readTrimmedNoErr(filepath.Join(rebaseMergeDir, "onto"))),
			"doneCount":     progress.done,
			"totalCount":    progress.total,
			"conflictCount": conflictCount,
		}
		if interactive, _ := pathExists(filepath.Join(rebaseMergeDir, "interactive")); interactive {
			state["variant"] = "interactive"
		}
		if label := readRebaseOntoLabelNoErr(rebaseMergeDir); label != nil {
			state["ontoLabel"] = *label
		}
		if subject := readFirstMessageLineNoErr(filepath.Join(rebaseMergeDir, "message")); subject != nil {
			state["currentCommitSubject"] = *subject
		}
		return state, nil
	}

	rebaseApplyDir := filepath.Join(gitDir, "rebase-apply")
	if exists, err := pathExists(rebaseApplyDir); err != nil {
		return nil, err
	} else if exists {
		progress := readRebaseProgressNoErr(rebaseApplyDir, "next", "last")
		state := map[string]any{
			"kind":          "rebase",
			"variant":       "apply",
			"headRef":       readRebaseHeadRefNoErr(rebaseApplyDir, headRef),
			"ontoRef":       stringPtrValue(readTrimmedNoErr(filepath.Join(rebaseApplyDir, "onto"))),
			"doneCount":     progress.done,
			"totalCount":    progress.total,
			"conflictCount": conflictCount,
		}
		if label := readRebaseOntoLabelNoErr(rebaseApplyDir); label != nil {
			state["ontoLabel"] = *label
		}
		if subject := readFirstMessageLineNoErr(filepath.Join(rebaseApplyDir, "message")); subject != nil {
			state["currentCommitSubject"] = *subject
		} else if subject := readFirstMessageLineNoErr(filepath.Join(rebaseApplyDir, "msg")); subject != nil {
			state["currentCommitSubject"] = *subject
		}
		return state, nil
	}

	cherryPickHead, err := readTrimmed(filepath.Join(gitDir, "CHERRY_PICK_HEAD"))
	if err != nil {
		return nil, err
	}
	if cherryPickHead != nil {
		state := map[string]any{
			"kind":          "cherry-pick",
			"sourceSha":     *cherryPickHead,
			"conflictCount": conflictCount,
		}
		if subject := readFirstMessageLineNoErr(filepath.Join(gitDir, "MERGE_MSG")); subject != nil {
			state["sourceSubject"] = *subject
		}
		return state, nil
	}

	revertHead, err := readTrimmed(filepath.Join(gitDir, "REVERT_HEAD"))
	if err != nil {
		return nil, err
	}
	if revertHead != nil {
		state := map[string]any{
			"kind":          "revert",
			"sourceSha":     *revertHead,
			"conflictCount": conflictCount,
		}
		if subject := readFirstMessageLineNoErr(filepath.Join(gitDir, "MERGE_MSG")); subject != nil {
			state["sourceSubject"] = *subject
		}
		return state, nil
	}

	return map[string]any{"kind": "none"}, nil
}

func readFetchHeadMtime(gitDir string) (*int64, error) {
	stat, err := os.Stat(filepath.Join(gitDir, "FETCH_HEAD"))
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	ms := stat.ModTime().UnixMilli()
	return &ms, nil
}

func readHeadRef(gitDir string) (*string, error) {
	head, err := readTrimmed(filepath.Join(gitDir, "HEAD"))
	if err != nil || head == nil {
		return nil, err
	}
	if !strings.HasPrefix(*head, "ref: ") {
		return head, nil
	}
	short := shortRefName(strings.TrimPrefix(*head, "ref: "))
	return &short, nil
}

func readRebaseHeadRefNoErr(rebaseDir string, fallback *string) *string {
	headName := readTrimmedNoErr(filepath.Join(rebaseDir, "head-name"))
	if headName == nil {
		return fallback
	}
	short := shortRefName(*headName)
	return &short
}

func readRebaseOntoLabelNoErr(rebaseDir string) *string {
	raw := readTrimmedNoErr(filepath.Join(rebaseDir, "onto_name"))
	if raw == nil {
		return nil
	}
	short := shortRefName(*raw)
	return &short
}

func readRebaseProgressNoErr(rebaseDir string, doneFile string, totalFile string) rebaseProgress {
	done := readTrimmedNoErr(filepath.Join(rebaseDir, doneFile))
	total := readTrimmedNoErr(filepath.Join(rebaseDir, totalFile))
	if done == nil || total == nil {
		return rebaseProgress{}
	}
	return rebaseProgress{done: parseNonnegativeInt(*done), total: parseNonnegativeInt(*total)}
}

func shortRefName(ref string) string {
	if strings.HasPrefix(ref, "refs/heads/") {
		return strings.TrimPrefix(ref, "refs/heads/")
	}
	if strings.HasPrefix(ref, "refs/remotes/") {
		return strings.TrimPrefix(ref, "refs/remotes/")
	}
	return ref
}

func mergeLabelFromMessage(message *string) *string {
	if message == nil {
		return nil
	}
	if start := strings.Index(*message, "'"); start >= 0 {
		if end := strings.Index((*message)[start+1:], "'"); end >= 0 {
			label := strings.TrimSpace((*message)[start+1 : start+1+end])
			if label != "" {
				return &label
			}
		}
	}
	trimmed := strings.TrimSpace(*message)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func parseNonnegativeInt(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func pathExists(absPath string) (bool, error) {
	_, err := os.Stat(absPath)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, iofs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func readTrimmed(absPath string) (*string, error) {
	buf, err := os.ReadFile(absPath)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	trimmed := strings.TrimSpace(string(buf))
	if trimmed == "" {
		return nil, nil
	}
	return &trimmed, nil
}

func readTrimmedNoErr(absPath string) *string {
	value, err := readTrimmed(absPath)
	if err != nil {
		return nil
	}
	return value
}

func readFirstMessageLineNoErr(absPath string) *string {
	text := readTrimmedNoErr(absPath)
	if text == nil {
		return nil
	}
	for _, line := range strings.Split(*text, "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		return &trimmed
	}
	return nil
}

func stringPtrValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
