package chat

// Deleting a session from a folder's list: Claude Code keeps a session as its
// transcript in the folder's project directory, with what it made while it
// ran in directories named by the session's id. Deleting it removes them
// all, so it leaves `claude --resume` too and gives back the space.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// fileSizesMax caps how many paths one chat.fileSizes asks about.
const fileSizesMax = 500

// DeleteSession deletes a session of a folder.
func (s *Service) DeleteSession(_ context.Context, raw json.RawMessage) (any, error) {
	var p DeleteSessionParams
	if err := decodeParams(raw, &p, "chat.deleteSession params must include cwd and sessionId"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" {
		return nil, protocolError("chat.deleteSession params must include cwd")
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.deleteSession sessionId is not a session id")
	}
	dir := configDir(p.ConfigDir)
	if dir == "" {
		return DeleteSessionResult{Deleted: false}, nil
	}
	deleted := false
	for _, project := range projectDirs(filepath.Join(dir, "projects"), p.Cwd) {
		transcript := filepath.Join(project, p.SessionID+".jsonl")
		info, err := os.Lstat(transcript)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := os.Remove(transcript); err != nil {
			return nil, requestFailed("chat.deleteSession: %s", err)
		}
		deleted = true
		// Its subagents' transcripts and the tool results kept beside it.
		_ = os.RemoveAll(filepath.Join(project, p.SessionID))
	}
	if !deleted {
		return DeleteSessionResult{Deleted: false}, nil
	}
	// What it kept elsewhere under its id: the files it edited, as they were
	// (for rewinding), and its shell's environment. The id has no separators,
	// so each of these stays inside the config directory.
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

// FileSizes tells how big transcripts are, for a list that has their paths
// but not their sizes (Codex's threads).
func (s *Service) FileSizes(_ context.Context, raw json.RawMessage) (any, error) {
	var p FileSizesParams
	if err := decodeParams(raw, &p, "chat.fileSizes params must include paths"); err != nil {
		return nil, err
	}
	if len(p.Paths) > fileSizesMax {
		return nil, protocolError("chat.fileSizes asks about too many paths")
	}
	sizes := map[string]int64{}
	for _, path := range p.Paths {
		if !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		sizes[path] = info.Size()
	}
	return FileSizesResult{Sizes: sizes}, nil
}
