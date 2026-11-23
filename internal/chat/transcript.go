package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/proto"
)

var sessionIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$`)

func (s *Service) Transcript(_ context.Context, raw json.RawMessage) (any, error) {
	var p TranscriptParams
	if err := proto.DecodeParams(raw, &p, "chat.transcript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, proto.ProtocolError("chat.transcript sessionId is not a session id")
	}
	path, info := findClaudeSession(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return TranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	lines, truncated, err := readJSONLines(path, info, transcriptCapBytes)
	if err != nil {
		return nil, proto.RequestFailed("chat.transcript: the transcript could not be read")
	}
	return TranscriptResult{Found: true, Lines: lines, Truncated: truncated}, nil
}

func (s *Service) SubagentTranscript(_ context.Context, raw json.RawMessage) (any, error) {
	var p SubagentTranscriptParams
	if err := proto.DecodeParams(raw, &p, "chat.subagentTranscript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, proto.ProtocolError("chat.subagentTranscript sessionId is not a session id")
	}
	if p.AgentID != "" && !agentIDPattern.MatchString(p.AgentID) {
		return nil, proto.ProtocolError("chat.subagentTranscript agentId is not an agent id")
	}
	if p.AgentID == "" && p.ToolUseID == "" {
		return nil, proto.ProtocolError("chat.subagentTranscript needs an agentId or a toolUseId")
	}
	path, info := findSubagent(configDir(p.ConfigDir), p.SessionID, p.AgentID, p.ToolUseID)
	if path == "" {
		return SubagentTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	lines, truncated, err := readJSONLinesWhere(path, info, transcriptCapBytes, isMessageLine)
	if err != nil {
		return nil, proto.RequestFailed("chat.subagentTranscript: the transcript could not be read")
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

func (s *Service) SessionFile(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionFileParams
	if err := proto.DecodeParams(raw, &p, "chat.sessionFile params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, proto.ProtocolError("chat.sessionFile sessionId is not a session id")
	}
	path, _ := findClaudeSession(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return SessionFileResult{Found: false}, nil
	}
	return SessionFileResult{Found: true, Path: path}, nil
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

func readJSONLines(path string, want os.FileInfo, limit int64) ([]json.RawMessage, bool, error) {
	return readJSONLinesWhere(path, want, limit, nil)
}

func readJSONLinesWhere(path string, want os.FileInfo, limit int64, keep func(json.RawMessage) bool) ([]json.RawMessage, bool, error) {
	file, info, err := openFound(path, want)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
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
