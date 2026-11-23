package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const historyChunk = 1 << 20

const slotTail = 128 + 9 + 2*4

type HistorySlotsParams struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId,omitempty"`
	ConfigDir   string `json:"configDir,omitempty"`
	ThreadID    string `json:"threadId,omitempty"`
	CodexHome   string `json:"codexHome,omitempty"`
}

type HistorySlotsResult struct {
	Found     bool     `json:"found"`
	Slots     []string `json:"slots"`
	Truncated bool     `json:"truncated,omitempty"`
}

func (s *Service) HistorySlots(_ context.Context, raw json.RawMessage) (any, error) {
	var p HistorySlotsParams
	if err := proto.DecodeParams(raw, &p, "chat.historySlots params must include workspaceId and sessionId or threadId"); err != nil {
		return nil, err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return nil, proto.ProtocolError("chat.historySlots workspaceId is required")
	}
	var root, path string
	var found os.FileInfo
	switch {
	case p.SessionID != "" && p.ThreadID == "":
		if !sessionIDPattern.MatchString(p.SessionID) {
			return nil, proto.ProtocolError("chat.historySlots sessionId is not a session id")
		}
		dir := configDir(p.ConfigDir)
		root = claudefiles.ProjectsDir(dir)
		path, found = claudefiles.FindSession(dir, p.SessionID)
	case p.ThreadID != "" && p.SessionID == "":
		if !sessionIDPattern.MatchString(p.ThreadID) {
			return nil, proto.ProtocolError("chat.historySlots threadId is not a thread id")
		}
		path = keptRollout(codexHome(p.CodexHome), p.ThreadID)
		root = filepath.Dir(path)
	default:
		return nil, proto.ProtocolError("chat.historySlots needs one of sessionId and threadId")
	}
	empty := HistorySlotsResult{Slots: []string{}}
	if path == "" {
		return empty, nil
	}
	attachments, err := attachRoot()
	if err != nil {
		return nil, proto.RequestFailed("chat.historySlots: the attachment folder could not be found: %s", proto.Reason(err))
	}
	slots, truncated, err := historySlots(root, path, found, filepath.Join(attachments, workspaceID))
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return nil, proto.RequestFailed("chat.historySlots: the transcript could not be read: %s", proto.Reason(err))
	}
	return HistorySlotsResult{Found: true, Slots: slots, Truncated: truncated}, nil
}

func historySlots(root, path string, want os.FileInfo, wsDir string) ([]string, bool, error) {
	file, _, err := claudefiles.Open(root, path, want)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	last, err := namedSlots(file, wsDir)
	if err != nil {
		return nil, false, err
	}
	slots := make([]string, 0, len(last))
	for slot := range last {
		slots = append(slots, slot)
	}
	sort.Slice(slots, func(i, j int) bool { return last[slots[i]] < last[slots[j]] })
	truncated := len(slots) > maxAttachSlots
	if truncated {
		slots = slots[len(slots)-maxAttachSlots:]
	}
	return slots, truncated, nil
}

func namedSlots(r io.Reader, wsDir string) (map[string]int64, error) {
	needle := foldedPath(wsDir)
	overlap := len(needle) + slotTail
	last := map[string]int64{}
	var base int64
	folded := make([]byte, 0, historyChunk+overlap)
	written := make([]byte, 0, historyChunk+overlap)
	chunk := make([]byte, historyChunk)
	separated := false
	for {
		n, readErr := r.Read(chunk)
		for _, c := range chunk[:n] {
			if c == '/' || c == '\\' {
				if !separated {
					folded = append(folded, '/')
					written = append(written, '/')
				}
				separated = true
				continue
			}
			separated = false
			written = append(written, c)
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			folded = append(folded, c)
		}
		done := readErr == io.EOF
		if readErr != nil && !done {
			return nil, readErr
		}
		limit := len(folded)
		if !done {
			limit = max(0, len(folded)-overlap)
		}
		for at := 0; at < limit; {
			i := bytes.Index(folded[at:], needle)
			if i < 0 || at+i >= limit {
				break
			}
			start := at + i + len(needle)
			if slot, ok := slotAt(folded[start:], written[start:]); ok {
				last[slot] = max(last[slot], base+int64(at+i))
			}
			at += i + 1
		}
		if done {
			return last, nil
		}
		base += int64(limit)
		folded = append(folded[:0], folded[limit:]...)
		written = append(written[:0], written[limit:]...)
	}
}

func foldedPath(path string) []byte {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	joined := strings.Join(parts, "/") + "/"
	if path != "" && (path[0] == '/' || path[0] == '\\') {
		joined = "/" + joined
	}
	folded := []byte(joined)
	for i, c := range folded {
		if c >= 'A' && c <= 'Z' {
			folded[i] = c + 'a' - 'A'
		}
	}
	return folded
}

func slotAt(folded, written []byte) (string, bool) {
	tab := 0
	for tab < len(folded) && tab <= 128 && slotTabByte(folded[tab]) {
		tab++
	}
	if tab == 0 || tab > 128 || tab >= len(folded) || folded[tab] != '/' {
		return "", false
	}
	rest := folded[tab+1:]
	n := 0
	for n < len(rest) && n <= 9 && rest[n] >= '0' && rest[n] <= '9' {
		n++
	}
	if n == 0 || n > 9 || n >= len(rest) || rest[n] != '/' {
		return "", false
	}
	return string(written[:tab]) + "/" + string(rest[:n]), true
}

func slotTabByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}
