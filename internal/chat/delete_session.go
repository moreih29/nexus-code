package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const fileSizesMax = 500

var statTranscript = os.Stat

func onLocalVolume(path string) bool {
	if runtime.GOOS != "windows" {
		return true
	}
	volume := filepath.VolumeName(path)
	return len(volume) == 2 && volume[1] == ':'
}

func (s *Service) DeleteSession(_ context.Context, raw json.RawMessage) (any, error) {
	var p DeleteSessionParams
	if err := proto.DecodeParams(raw, &p, "chat.deleteSession params must include cwd and sessionId"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" {
		return nil, proto.ProtocolError("chat.deleteSession params must include cwd")
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, proto.ProtocolError("chat.deleteSession sessionId is not a session id")
	}
	dir := configDir(p.ConfigDir)
	if dir == "" {
		return DeleteSessionResult{Deleted: false}, nil
	}
	deleted := false
	projects := claudefiles.ProjectsDir(dir)
	for _, project := range claudeProjectFoldersFor(projects, p.Cwd) {
		transcript := filepath.Join(project, p.SessionID+".jsonl")
		if _, ok := claudefiles.RegularFile(transcript); !ok {
			continue
		}
		if err := claudefiles.Remove(projects, transcript); err != nil {
			return nil, proto.RequestFailed("chat.deleteSession: the transcript could not be removed: %s", proto.Reason(err))
		}
		deleted = true
		_ = claudefiles.RemoveAll(projects, filepath.Join(project, p.SessionID))
	}
	if !deleted {
		return DeleteSessionResult{Deleted: false}, nil
	}
	_ = os.RemoveAll(filepath.Join(dir, "file-history", p.SessionID))
	_ = os.RemoveAll(filepath.Join(dir, "session-env", p.SessionID))
	_ = os.Remove(filepath.Join(dir, "debug", p.SessionID+".txt"))
	if todos, err := filepath.Glob(filepath.Join(dir, "todos", globEscape(p.SessionID)+"-*.json")); err == nil {
		for _, todo := range todos {
			_ = os.Remove(todo)
		}
	}
	return DeleteSessionResult{Deleted: true}, nil
}

func (s *Service) FileSizes(_ context.Context, raw json.RawMessage) (any, error) {
	var p FileSizesParams
	if err := proto.DecodeParams(raw, &p, "chat.fileSizes params must include paths"); err != nil {
		return nil, err
	}
	if len(p.Paths) > fileSizesMax {
		return nil, proto.ProtocolError("chat.fileSizes asks about too many paths")
	}
	sizes := map[string]int64{}
	for _, path := range p.Paths {
		if !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") || !onLocalVolume(path) {
			continue
		}
		info, err := statTranscript(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		sizes[path] = info.Size()
	}
	return FileSizesResult{Sizes: sizes}, nil
}
