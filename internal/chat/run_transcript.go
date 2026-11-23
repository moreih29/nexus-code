package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
)

// RunTranscriptParams is the wire shape for chat.runTranscript: a print
// run's session (claude -p) read on from a place in its transcript.
type RunTranscriptParams struct {
	SessionID string `json:"sessionId"`
	// ConfigDir is as TranscriptParams has it: the run's own config
	// directory, as its print-start told it.
	ConfigDir string `json:"configDir,omitempty"`
	// From is where the last read ended (its Next); absent for the first.
	From *int64 `json:"from,omitempty"`
}

// RunTranscriptResult is returned by chat.runTranscript: the whole lines
// written from From, the last ones when more than the cap was; Next is
// where the next read goes on. Reset: the file is shorter than From, so it
// was read again from its start (as when From is absent).
type RunTranscriptResult struct {
	Found     bool              `json:"found"`
	Lines     []json.RawMessage `json:"lines"`
	Next      int64             `json:"next"`
	Reset     bool              `json:"reset,omitempty"`
	Truncated bool              `json:"truncated,omitempty"`
}

// RunTranscript reads a print run's transcript as it grows: a line still
// being written is left for the next read.
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
	path := transcriptPath(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return RunTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	result, err := readRunTranscript(path, p.From, transcriptCapBytes)
	if err != nil {
		return nil, requestFailed("chat.runTranscript: %s", err)
	}
	return result, nil
}

// readRunTranscript reads the whole lines of path from `from` (from its
// start when nil, or when the file is shorter), the last `limit` bytes of
// them at most.
func readRunTranscript(path string, from *int64, limit int64) (RunTranscriptResult, error) {
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
	size := info.Size()
	var start int64
	if from != nil {
		if *from > size {
			result.Reset = true
		} else {
			start = *from
		}
	}
	// Past the cap, only its last bytes are read, from the line after the
	// one the cut falls in.
	partial := false
	if size-start > limit {
		start, partial, result.Truncated = size-limit, true, true
	}
	if partial && start > 0 {
		// A cut just after a newline falls on a line's start.
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
