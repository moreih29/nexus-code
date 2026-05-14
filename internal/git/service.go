package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/content"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const maxGitFileContentBytes = 5 * 1024 * 1024

type Service struct {
	root string

	mu       sync.Mutex
	sink     EventSink
	streams  map[string]context.CancelFunc
	watches  map[string]*watchEntry
	gitDirty map[string]struct{}
	timer    *time.Timer

	askpassListener   net.Listener
	askpassSocketPath string
	askpassSocketDir  string
	askpassPending    map[string]chan askpassResolution
}

type FileContentParams struct {
	Ref     string `json:"ref"`
	RelPath string `json:"relPath"`
}

// EventSink is the callback git uses to push agent events back to Electron.
type EventSink func(event string, payload any) error

func New(root string) *Service {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	return &Service{
		root:           filepath.Clean(abs),
		streams:        make(map[string]context.CancelFunc),
		watches:        make(map[string]*watchEntry),
		gitDirty:       make(map[string]struct{}),
		askpassPending: make(map[string]chan askpassResolution),
	}
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("git.run", service.Run)
	d.Register("git.stream", service.Stream)
	d.Register("git.cancel", service.Cancel)
	d.Register("git.askpass.respond", service.RespondAskpass)
	d.Register("git.metadata", service.Metadata)
	d.Register("git.status", service.Status)
	d.Register("git.log", service.Log)
	d.Register("git.diff", service.Diff)
	d.Register("git.commitDetail", service.CommitDetail)
	d.Register("git.watch", service.Watch)
	d.Register("git.unwatch", service.Unwatch)
	d.Register("git.addToGitignore", service.AddToGitignore)
	d.Register("git.getFileContent", service.GetFileContent)
	d.Register("git.blob", service.Blob)
	d.Register("git.stash.list", service.StashList)
	d.Register("git.stash.apply", service.StashApply)
	d.Register("git.stash.drop", service.StashDrop)
	d.Register("git.stash.pop", service.StashPop)
	d.Register("git.stash.show", service.StashShow)
	d.Register("git.stash.group", service.StashGroup)
	d.Register("git.tag.list", service.TagList)
	d.Register("git.tag.listRemote", service.TagListRemote)
	d.Register("git.tag.create", service.TagCreate)
	d.Register("git.tag.delete", service.TagDelete)
	d.Register("git.tag.deleteRemote", service.TagDeleteRemote)
	d.Register("git.tag.push", service.TagPush)
	d.Register("git.remote.add", service.RemoteAdd)
	d.Register("git.remote.remove", service.RemoteRemove)
	d.Register("git.workflow.merge", service.WorkflowMerge)
	d.Register("git.workflow.rebase", service.WorkflowRebase)
	d.Register("git.workflow.cherryPick", service.WorkflowCherryPick)
	d.Register("git.workflow.abort", service.WorkflowAbort)
	d.Register("git.workflow.continue", service.WorkflowContinue)
	d.Register("git.conflict.markResolved", service.ConflictMarkResolved)
	d.Register("git.branch.create", service.BranchCreate)
	d.Register("git.branch.delete", service.BranchDelete)
	d.Register("git.branch.deleteRemote", service.BranchDeleteRemote)
	d.Register("git.branch.rename", service.BranchRename)
	d.Register("git.branch.setUpstream", service.BranchSetUpstream)
	d.Register("git.branch.fastForward", service.BranchFastForward)
}

func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

func (s *Service) Close() {
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	for id, cancel := range s.streams {
		cancel()
		delete(s.streams, id)
	}
	for dir, entry := range s.watches {
		entry.close()
		delete(s.watches, dir)
	}
	s.closeAskpassServerLocked()
	clear(s.gitDirty)
	s.mu.Unlock()
}

func (s *Service) GetFileContent(ctx context.Context, raw json.RawMessage) (any, error) {
	var p FileContentParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.getFileContent params must include ref and relPath")
	}
	ref, err := normalizeRef(p.Ref)
	if err != nil {
		return nil, err
	}
	relPath, err := normalizeRelPath(p.RelPath)
	if err != nil {
		return nil, err
	}
	if ref == "WORKING" {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git.getFileContent does not support WORKING refs; use fs.readFile for working-tree content"}
	}

	objectSpec := ref + ":" + relPath
	if ref == "INDEX" {
		objectSpec = ":" + relPath
	}

	stdout, stderr, err := runGitShow(ctx, s.root, objectSpec)
	if err != nil {
		if isMissing(stderr) {
			return map[string]any{"kind": "missing", "reason": missingReasonForRef(ref)}, nil
		}
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: strings.TrimSpace(stderr)}
	}
	if len(stdout) > maxGitFileContentBytes {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("Git blob %s exceeds %d byte read limit", relPath, maxGitFileContentBytes)}
	}
	return buildFileReadResult(stdout), nil
}

func runGitShow(ctx context.Context, root string, objectSpec string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, "git", "show", "--no-ext-diff", objectSpec)
	cmd.Dir = root
	cmd.Env = append(cmd.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=echo",
		"SSH_ASKPASS_REQUIRE=force",
		"SSH_ASKPASS=echo",
		"GIT_FLUSH=1",
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.Output()
	return stdout, stderr.String(), err
}

func buildFileReadResult(buf []byte) map[string]any {
	probe := buf
	if len(probe) > content.BinaryProbeBytes {
		probe = probe[:content.BinaryProbeBytes]
	}
	mtime := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if content.IsBinaryProbe(probe) {
		return map[string]any{
			"kind":      "ok",
			"content":   "",
			"encoding":  "utf8",
			"sizeBytes": len(buf),
			"isBinary":  true,
			"mtime":     mtime,
		}
	}
	if len(probe) >= 3 && probe[0] == 0xef && probe[1] == 0xbb && probe[2] == 0xbf {
		return map[string]any{
			"kind":      "ok",
			"content":   string(buf[3:]),
			"encoding":  "utf8-bom",
			"sizeBytes": len(buf),
			"isBinary":  false,
			"mtime":     mtime,
		}
	}
	text := string(buf)
	if !utf8.Valid(buf) {
		text = strings.ToValidUTF8(text, "�")
	}
	return map[string]any{
		"kind":      "ok",
		"content":   text,
		"encoding":  "utf8",
		"sizeBytes": len(buf),
		"isBinary":  false,
		"mtime":     mtime,
	}
}

func normalizeRef(ref string) (string, error) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" || strings.Contains(trimmed, "\x00") {
		return "", proto.ProtocolError("git.getFileContent ref is required")
	}
	return trimmed, nil
}

func normalizeRelPath(relPath string) (string, error) {
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
		return "", proto.ProtocolError("git.getFileContent relPath must stay inside the repository")
	}
	return normalized, nil
}

var windowsAbs = regexp.MustCompile(`^[A-Za-z]:/`)

func containsPart(parts []string, target string) bool {
	for _, part := range parts {
		if part == target {
			return true
		}
	}
	return false
}

func isMissing(stderr string) bool {
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "does not exist") ||
		strings.Contains(lower, "exists on disk, but not in") ||
		strings.Contains(lower, "invalid object name") ||
		strings.Contains(lower, "pathspec") && strings.Contains(lower, "did not match")
}

func missingReasonForRef(ref string) string {
	if ref == "INDEX" {
		return "index"
	}
	if refHead.MatchString(ref) || shaLike.MatchString(ref) || strings.Contains(ref, "/") || strings.Contains(ref, "..") {
		return "ref"
	}
	return "not-found"
}

var refHead = regexp.MustCompile(`(?i)^(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|FETCH_HEAD)$`)
var shaLike = regexp.MustCompile(`^[0-9a-f]{4,40}$`)
