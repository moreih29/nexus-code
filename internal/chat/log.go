package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"time"
)

type entry struct {
	seq       int64
	dir       string
	message   json.RawMessage
	text      string
	at        int64
	transient bool
	pins      int
	requestID string
}

func (e *entry) size() int {
	return len(e.message) + len(e.text) + 64
}

type lineLog struct {
	entries       []*entry
	bytes         int
	nextSeq       int64
	truncated     bool
	transientFrom int
	cap           int
	replayPins    map[string][2]*entry
	requests      map[string]replayRequest
	input         *entry
	inputResponse *entry
}

func newLineLog() *lineLog {
	return &lineLog{
		nextSeq: 1, transientFrom: -1, cap: logCapBytes,
		replayPins: make(map[string][2]*entry), requests: make(map[string]replayRequest),
	}
}

func (l *lineLog) add(dir string, message json.RawMessage, text string) *entry {
	e := &entry{seq: l.nextSeq, dir: dir, message: message, text: text, at: time.Now().UnixMilli()}
	l.nextSeq++
	var kind string
	if dir == DirOut && message != nil {
		kind = messageType(message)
		if kind == "stream_event" {
			e.transient = true
		} else if completesStream(kind) {
			l.dropTransient()
		}
	}
	if e.transient && l.transientFrom < 0 {
		l.transientFrom = len(l.entries)
	}
	l.entries = append(l.entries, e)
	l.bytes += e.size()
	l.keepReplayState(e, kind)
	l.trim()
	return e
}

func (l *lineLog) reserveInput(message json.RawMessage) *entry {
	slot := l.add(DirSys, nil, "")
	if bytes.Contains(message, []byte(`"control_request"`)) &&
		messageType(message) == "control_request" && l.trackReplayRequest(slot, message) {
		l.input = slot
		l.changePins(slot, 1)
	}
	return slot
}

func (l *lineLog) finishInput(slot *entry, dir string, message json.RawMessage) {
	for _, e := range l.since(slot.seq - 1) {
		if e == slot {
			if e.pins == 0 {
				l.bytes += len(message)
			}
			break
		}
	}
	slot.dir = dir
	slot.message = message
	if l.input == slot {
		response := l.inputResponse
		l.input, l.inputResponse = nil, nil
		l.changePins(slot, -1)
		if dir != DirIn {
			l.forgetReplayRequest(slot.requestID)
		}
		if response != nil {
			l.changePins(response, -1)
			if dir == DirIn {
				l.keepReplayResponse(response)
			}
		}
	}
	l.trim()
}

func (l *lineLog) addPinned(dir string, message json.RawMessage) *entry {
	e := &entry{seq: l.nextSeq, dir: dir, message: message, at: time.Now().UnixMilli(), pins: 1}
	l.nextSeq++
	l.entries = append(l.entries, e)
	return e
}

func (l *lineLog) reset() {
	l.entries = nil
	l.bytes = 0
	l.truncated = false
	l.transientFrom = -1
	clear(l.replayPins)
	clear(l.requests)
	l.input, l.inputResponse = nil, nil
}

func (l *lineLog) lastSeq() int64 {
	return l.nextSeq - 1
}

func (l *lineLog) since(seq int64) []*entry {
	for i, e := range l.entries {
		if e.seq > seq {
			return l.entries[i:]
		}
	}
	return nil
}

func (l *lineLog) dropTransient() {
	if l.transientFrom < 0 {
		return
	}
	kept := l.entries[:l.transientFrom]
	for _, e := range l.entries[l.transientFrom:] {
		if e.transient {
			l.bytes -= e.size()
			continue
		}
		kept = append(kept, e)
	}
	for i := len(kept); i < len(l.entries); i++ {
		l.entries[i] = nil
	}
	l.entries = kept
	l.transientFrom = -1
}

func (l *lineLog) trim() {
	if l.bytes <= l.cap {
		return
	}
	last := len(l.entries) - 1
	rest := make([]*entry, 0, cap(l.entries))
	dropped := 0
	for i, e := range l.entries {
		if l.bytes > l.cap && i < last && e.pins == 0 {
			l.bytes -= e.size()
			if l.requests[e.requestID].line == e {
				delete(l.requests, e.requestID)
			}
			if i < l.transientFrom {
				dropped++
			}
			continue
		}
		rest = append(rest, e)
	}
	if len(rest) == len(l.entries) {
		return
	}
	l.truncated = true
	l.entries = rest
	if l.transientFrom >= 0 {
		l.transientFrom -= dropped
		if l.transientFrom >= len(l.entries) {
			l.transientFrom = len(l.entries) - 1
		}
	}
}

func completesStream(kind string) bool {
	switch kind {
	case "assistant", "user", "result":
		return true
	}
	return false
}

func messageType(message json.RawMessage) string {
	const lead = `{"type":"`
	if rest, ok := bytes.CutPrefix(message, []byte(lead)); ok {
		if j := bytes.IndexByte(rest, '"'); j >= 0 && j < 64 && bytes.IndexByte(rest[:j], '\\') < 0 {
			return string(rest[:j])
		}
	}
	var probe struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(message, &probe) != nil {
		return ""
	}
	return probe.Type
}

var errLineTooLong = errors.New("line too long")

func readLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	tooLong := false
	for {
		chunk, err := reader.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > limit {
				tooLong = true
				line = nil
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if tooLong && err == nil {
			return nil, errLineTooLong
		}
		return line, err
	}
}
