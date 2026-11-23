package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
	"github.com/nexus-code/nexus-code/internal/proto"
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
	if err := proto.DecodeParams(raw, &p, "chat.runTranscript params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) {
		return nil, proto.ProtocolError("chat.runTranscript sessionId is not a session id")
	}
	if p.From != nil && *p.From < 0 {
		return nil, proto.ProtocolError("chat.runTranscript from is negative")
	}
	dir := configDir(p.ConfigDir)
	path, info := claudefiles.FindSession(dir, p.SessionID)
	if path == "" {
		return RunTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	result, err := readRunTranscript(claudefiles.ProjectsDir(dir), path, info, p.From, transcriptCapBytes)
	if err != nil {
		return nil, proto.RequestFailed("chat.runTranscript: the run's transcript could not be read")
	}
	return result, nil
}

func readRunTranscript(projects, path string, want os.FileInfo, from *int64, limit int64) (RunTranscriptResult, error) {
	result := RunTranscriptResult{Found: true, Lines: []json.RawMessage{}}
	file, info, err := claudefiles.Open(projects, path, want)
	if err != nil {
		return result, err
	}
	defer file.Close()
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
