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
	if err := decodeParams(raw, &p, "chat.historySlots params must include workspaceId and sessionId or threadId"); err != nil {
		return nil, err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return nil, protocolError("chat.historySlots workspaceId is required")
	}
	var path string
	switch {
	case p.SessionID != "" && p.ThreadID == "":
		if !sessionIDPattern.MatchString(p.SessionID) {
			return nil, protocolError("chat.historySlots sessionId is not a session id")
		}
		path = transcriptPath(configDir(p.ConfigDir), p.SessionID)
	case p.ThreadID != "" && p.SessionID == "":
		if !sessionIDPattern.MatchString(p.ThreadID) {
			return nil, protocolError("chat.historySlots threadId is not a thread id")
		}
		path = keptRollout(codexHome(p.CodexHome), p.ThreadID)
	default:
		return nil, protocolError("chat.historySlots needs one of sessionId and threadId")
	}
	empty := HistorySlotsResult{Slots: []string{}}
	if path == "" {
		return empty, nil
	}
	root, err := attachRoot()
	if err != nil {
		return nil, requestFailed("chat.historySlots: %v", err)
	}
	slots, truncated, err := historySlots(path, filepath.Join(root, workspaceID))
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return nil, requestFailed("chat.historySlots: %v", err)
	}
	return HistorySlotsResult{Found: true, Slots: slots, Truncated: truncated}, nil
}

func historySlots(path, wsDir string) ([]string, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	needles := slotNeedles(wsDir)
	longest := 0
	for _, needle := range needles {
		longest = max(longest, len(needle))
	}
	overlap := longest + slotTail
	last := map[string]int64{}
	var base int64
	buf := make([]byte, 0, historyChunk+overlap)
	chunk := make([]byte, historyChunk)
	for {
		n, readErr := file.Read(chunk)
		buf = append(buf, chunk[:n]...)
		done := readErr == io.EOF
		if readErr != nil && !done {
			return nil, false, readErr
		}
		limit := len(buf)
		if !done {
			limit = max(0, len(buf)-overlap)
		}
		folded := asciiLower(buf)
		for _, needle := range needles {
			for at := 0; at < limit; {
				i := bytes.Index(folded[at:], needle)
				if i < 0 || at+i >= limit {
					break
				}
				start := at + i + len(needle)
				if slot, ok := slotAt(buf[start:]); ok {
					last[slot] = max(last[slot], base+int64(at+i))
				}
				at += i + 1
			}
		}
		if done {
			break
		}
		base += int64(limit)
		buf = append(buf[:0], buf[limit:]...)
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

func slotNeedles(wsDir string) [][]byte {
	parts := strings.FieldsFunc(wsDir, func(r rune) bool { return r == '/' || r == '\\' })
	lead := wsDir != "" && (wsDir[0] == '/' || wsDir[0] == '\\')
	var needles [][]byte
	for _, sep := range []string{"/", `\`, `\\`, `\/`, `\\\\`} {
		joined := strings.Join(parts, sep) + sep
		if lead {
			joined = sep + joined
		}
		needles = append(needles, asciiLower([]byte(joined)))
	}
	return needles
}

func slotAt(b []byte) (string, bool) {
	tab := 0
	for tab < len(b) && tab <= 128 && slotTabByte(b[tab]) {
		tab++
	}
	if tab == 0 || tab > 128 {
		return "", false
	}
	rest, ok := cutSeparator(b[tab:])
	if !ok {
		return "", false
	}
	n := 0
	for n < len(rest) && n <= 9 && rest[n] >= '0' && rest[n] <= '9' {
		n++
	}
	if n == 0 || n > 9 {
		return "", false
	}
	if _, ok := cutSeparator(rest[n:]); !ok {
		return "", false
	}
	return string(b[:tab]) + "/" + string(rest[:n]), true
}

func slotTabByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

func cutSeparator(b []byte) ([]byte, bool) {
	switch {
	case len(b) >= 4 && b[0] == '\\' && b[1] == '\\' && b[2] == '\\' && b[3] == '\\':
		return b[4:], true
	case len(b) >= 2 && b[0] == '\\' && (b[1] == '\\' || b[1] == '/'):
		return b[2:], true
	case len(b) >= 1 && (b[0] == '/' || b[0] == '\\'):
		return b[1:], true
	}
	return nil, false
}

func asciiLower(b []byte) []byte {
	out := make([]byte, len(b))
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return out
}
