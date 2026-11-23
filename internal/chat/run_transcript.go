package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type RunTranscriptParams struct {
	SessionID string `json:"sessionId"`
	ConfigDir string `json:"configDir,omitempty"`
	From      *int64 `json:"from,omitempty"`
}

type RunTranscriptResult struct {
	Found     bool              `json:"found"`
	Lines     []json.RawMessage `json:"lines"`
	Next      int64             `json:"next"`
	Reset     bool              `json:"reset,omitempty"`
	Truncated bool              `json:"truncated,omitempty"`
}

func (s *Service) RunTranscript(_ context.Context, raw json.RawMessage) (any, error) {
	var p RunTranscriptParams
	if err := decodeParams(raw, &p, "chat.runTranscript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, protocolError("chat.runTranscript sessionId is not a session id")
	}
	if p.From != nil && *p.From < 0 {
		return nil, protocolError("chat.runTranscript from is negative")
	}
	path, info := runTranscriptPath(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return RunTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	result, err := readRunTranscript(path, info, p.From, transcriptCapBytes)
	if err != nil {
		return nil, requestFailed("chat.runTranscript: the run's transcript could not be read")
	}
	return result, nil
}

func runTranscriptPath(dir, sessionID string) (string, os.FileInfo) {
	if dir == "" {
		return "", nil
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", nil
	}
	projects, err := filepath.EvalSymlinks(filepath.Join(root, "projects"))
	if err != nil {
		return "", nil
	}
	if info, err := os.Lstat(projects); err != nil || !info.IsDir() {
		return "", nil
	}
	entries, err := os.ReadDir(projects)
	if err != nil {
		return "", nil
	}
	found := ""
	var foundInfo os.FileInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(projects, entry.Name(), sessionID+".jsonl")
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if foundInfo == nil || info.ModTime().After(foundInfo.ModTime()) {
			found, foundInfo = path, info
		}
	}
	return found, foundInfo
}

func readRunTranscript(path string, want os.FileInfo, from *int64, limit int64) (RunTranscriptResult, error) {
	result := RunTranscriptResult{Found: true, Lines: []json.RawMessage{}}
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return result, err
	}
	if !info.Mode().IsRegular() || (want != nil && !os.SameFile(want, info)) {
		return result, errors.New("the transcript is not the file that was found")
	}
	size := info.Size()
	var start int64
	if from != nil {
		if *from > size {
			result.Reset = true
		} else {
			start = *from
		}
	}
	partial := false
	if size-start > limit {
		start, partial, result.Truncated = size-limit, true, true
	}
	if partial && start > 0 {
		var before [1]byte
		if _, err := file.ReadAt(before[:], start-1); err != nil {
			return result, err
		}
		partial = before[0] != '\n'
	}
	data := make([]byte, size-start)
	if _, err := io.ReadFull(io.NewSectionReader(file, start, size-start), data); err != nil {
		return result, err
	}
	if partial {
		cut := bytes.IndexByte(data, '\n')
		if cut < 0 {
			result.Next = start
			return result, nil
		}
		data, start = data[cut+1:], start+int64(cut+1)
	}
	end := bytes.LastIndexByte(data, '\n') + 1
	result.Next = start + int64(end)
	for _, line := range bytes.Split(data[:end], []byte{'\n'}) {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 && json.Valid(trimmed) {
			result.Lines = append(result.Lines, json.RawMessage(trimmed))
		}
	}
	return result, nil
}
