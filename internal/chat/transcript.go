package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

var sessionIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$`)

func (s *Service) Transcript(_ context.Context, raw json.RawMessage) (any, error) {
	var p TranscriptParams
	if err := decodeParams(raw, &p, "chat.transcript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.transcript sessionId is not a session id")
	}
	path := transcriptPath(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return TranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	lines, truncated, err := readJSONLines(path, transcriptCapBytes)
	if err != nil {
		return nil, requestFailed("chat.transcript: %s", err)
	}
	return TranscriptResult{Found: true, Lines: lines, Truncated: truncated}, nil
}

func (s *Service) SubagentTranscript(_ context.Context, raw json.RawMessage) (any, error) {
	var p SubagentTranscriptParams
	if err := decodeParams(raw, &p, "chat.subagentTranscript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.subagentTranscript sessionId is not a session id")
	}
	if p.AgentID != "" && !agentIDPattern.MatchString(p.AgentID) {
		return nil, protocolError("chat.subagentTranscript agentId is not an agent id")
	}
	if p.AgentID == "" && p.ToolUseID == "" {
		return nil, protocolError("chat.subagentTranscript needs an agentId or a toolUseId")
	}
	path := subagentPath(configDir(p.ConfigDir), p.SessionID, p.AgentID, p.ToolUseID)
	if path == "" {
		return SubagentTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	lines, truncated, err := readJSONLinesWhere(path, transcriptCapBytes, isMessageLine)
	if err != nil {
		return nil, requestFailed("chat.subagentTranscript: %s", err)
	}
	return SubagentTranscriptResult{Found: true, Lines: lines, Truncated: truncated}, nil
}

var agentIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$`)

func isMessageLine(line json.RawMessage) bool {
	switch messageType(line) {
	case "user", "assistant":
		return true
	}
	return false
}

func subagentPath(dir, sessionID, agentID, toolUseID string) string {
	if dir == "" {
		return ""
	}
	projects := filepath.Join(dir, "projects")
	entries, _ := os.ReadDir(projects)
	folders := make([]string, 0, len(entries))
	for _, entry := range entries {
		folders = append(folders, filepath.Join(projects, entry.Name(), sessionID, "subagents"))
	}
	if agentID != "" {
		paths := make([]string, 0, len(folders))
		for _, folder := range folders {
			paths = append(paths, filepath.Join(folder, "agent-"+agentID+".jsonl"))
		}
		if found := newestFile(paths); found != "" || toolUseID == "" {
			return found
		}
	}
	var paths []string
	for _, folder := range folders {
		files, _ := os.ReadDir(folder)
		for _, file := range files {
			name := file.Name()
			if !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".meta.json") {
				continue
			}
			meta := filepath.Join(folder, name)
			if subagentCallOf(meta) == toolUseID {
				paths = append(paths, strings.TrimSuffix(meta, ".meta.json")+".jsonl")
			}
		}
	}
	return newestFile(paths)
}

const subagentMetaCap = 64 * 1024

func subagentCallOf(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	var meta struct {
		ToolUseID string `json:"toolUseId"`
	}
	if json.NewDecoder(io.LimitReader(file, subagentMetaCap)).Decode(&meta) != nil {
		return ""
	}
	return meta.ToolUseID
}

func (s *Service) SessionFile(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionFileParams
	if err := decodeParams(raw, &p, "chat.sessionFile params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.sessionFile sessionId is not a session id")
	}
	path := transcriptPath(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return SessionFileResult{Found: false}, nil
	}
	return SessionFileResult{Found: true, Path: path}, nil
}

func transcriptPath(dir, sessionID string) string {
	if dir == "" {
		return ""
	}
	projects := filepath.Join(dir, "projects")
	entries, err := os.ReadDir(projects)
	if err != nil {
		return ""
	}
	matches := make([]string, 0, len(entries))
	for _, entry := range entries {
		matches = append(matches, filepath.Join(projects, entry.Name(), sessionID+".jsonl"))
	}
	return newestFile(matches)
}

func newestFile(paths []string) string {
	found := ""
	var newest int64 = -1
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if t := info.ModTime().UnixNano(); t > newest {
			newest = t
			found = path
		}
	}
	return found
}

func configDir(given string) string {
	home, _ := os.UserHomeDir()
	if dir := agentpaths.ProfileEnvDir("CLAUDE_CONFIG_DIR", given); dir != "" {
		return dir
	}
	return defaultProfileDir("claude", home)
}

func readJSONLines(path string, limit int64) ([]json.RawMessage, bool, error) {
	return readJSONLinesWhere(path, limit, nil)
}

func readJSONLinesWhere(path string, limit int64, keep func(json.RawMessage) bool) ([]json.RawMessage, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	truncated := false
	if info.Size() > limit {
		truncated = true
		if _, err := file.Seek(info.Size()-limit, io.SeekStart); err != nil {
			return nil, false, err
		}
	}
	reader := bufio.NewReaderSize(file, 64*1024)
	if truncated {
		for {
			_, err := reader.ReadSlice('\n')
			if errors.Is(err, bufio.ErrBufferFull) {
				continue
			}
			if err != nil {
				return []json.RawMessage{}, true, nil
			}
			break
		}
	}
	lines := []json.RawMessage{}
	for {
		line, err := readLine(reader, maxLineBytes)
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 && json.Valid(trimmed) && (keep == nil || keep(trimmed)) {
			lines = append(lines, json.RawMessage(bytes.Clone(trimmed)))
		}
		if errors.Is(err, errLineTooLong) {
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return lines, truncated, nil
			}
			return nil, false, err
		}
	}
}
