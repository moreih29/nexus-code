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
	path, info := runTranscriptPath(configDir(p.ConfigDir), p.SessionID)
	if path == "" {
		return RunTranscriptResult{Found: false, Lines: []json.RawMessage{}}, nil
	}
	result, err := readRunTranscript(path, info, p.From, transcriptCapBytes)
	if err != nil {
		// The error names the file: where a run keeps its session is not told back.
		return nil, requestFailed("chat.runTranscript: the run's transcript could not be read")
	}
	return result, nil
}

// runTranscriptPath is the file a run's session is kept in under the config
// folder the run told, with what it is, "" when none is found. The folder
// comes from the run's own start, not from a profile's settings, so nothing
// under it is followed out of it: the folder itself is resolved first (a
// user's ~/.claude may be a link), then `projects`, the project's folder and
// the file must each be what they are named, no link. The newest one when
// several projects have it.
func runTranscriptPath(dir, sessionID string) (string, os.FileInfo) {
	if dir == "" {
		return "", nil
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", nil
	}
	// The projects folder may be a link itself (kept on another disk): what is
	// read is a regular file in a real folder of where it leads.
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
		// A link's type is a link's, whatever it points at.
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

// readRunTranscript reads the whole lines of path from `from` (from its
// start when nil, or when the file is shorter), the last `limit` bytes of
// them at most.
//
// With `want`, the file opened must be the one that was found: one put in
// its place since (a link to another) is not read.
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
