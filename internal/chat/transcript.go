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
)

// sessionIDPattern is what a Claude Code session id looks like. Anything
// else is refused, so the id cannot name a path.
var sessionIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$`)

// Transcript returns a session's transcript, so a tab opened again after
// the agent restarted can show the conversation it resumes. Claude Code
// keeps it as <config>/projects/<project>/<session id>.jsonl.
func (s *Service) Transcript(_ context.Context, raw json.RawMessage) (any, error) {
	var p TranscriptParams
	if err := decodeParams(raw, &p, "chat.transcript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.transcript sessionId is not a session id")
	}
	dir := configDir(p.ConfigDir)
	if dir == "" {
		return TranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "projects", "*", p.SessionID+".jsonl"))
	if len(matches) == 0 {
		return TranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	// The newest one when several projects have it: a session moved with
	// its folder.
	path := matches[0]
	var newest int64
	for _, match := range matches {
		if info, err := os.Stat(match); err == nil && info.ModTime().UnixNano() > newest {
			newest = info.ModTime().UnixNano()
			path = match
		}
	}
	lines, truncated, err := readJSONLines(path, transcriptCapBytes)
	if err != nil {
		return nil, requestFailed("chat.transcript: %s", err)
	}
	return TranscriptResult{Found: true, Lines: lines, Truncated: truncated}, nil
}

// configDir resolves Claude Code's config directory on this host.
func configDir(given string) string {
	home, _ := os.UserHomeDir()
	given = strings.TrimSpace(given)
	if given == "" {
		given = os.Getenv("CLAUDE_CONFIG_DIR")
	}
	if given == "" {
		if home == "" {
			return ""
		}
		return filepath.Join(home, ".claude")
	}
	// A profile's folder, "~\…" too as one picked on Windows reads.
	if dir := expandProfileDir(given, home); dir != "" {
		return dir
	}
	return given
}

// readJSONLines reads a JSON-lines file, keeping its last lines within
// limit bytes. Lines that are not JSON are skipped.
func readJSONLines(path string, limit int64) ([]json.RawMessage, bool, error) {
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
		// The first line read from the middle of the file is a part of one.
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
		if len(trimmed) > 0 && json.Valid(trimmed) {
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
