package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"time"
)

// entry is one line of a tab's log.
type entry struct {
	seq     int64
	dir     string
	message json.RawMessage
	text    string
	// at is when the line came, in Unix milliseconds.
	at int64
	// transient marks a stream event: a token of a message still being
	// written. The complete message follows it, and then it is dropped.
	transient bool
	// A file original or replay state is kept outside the rolling cap.
	pins      int
	requestID string
}

func (e *entry) size() int {
	return len(e.message) + len(e.text) + 64
}

// lineLog keeps a tab's lines for replay, within logCapBytes. Its methods
// are called with the session's lock held.
type lineLog struct {
	entries []*entry
	bytes   int
	nextSeq int64
	// truncated reports that the oldest lines were dropped for the cap.
	truncated bool
	// transientFrom is the index of the first transient entry since the
	// last complete message, or -1.
	transientFrom int
	cap           int
	replayPins    map[string][2]*entry
	requests      map[string]replayRequest
	// A response can arrive before its input write returns. Commit it to
	// replay state only once the input is confirmed.
	input         *entry
	inputResponse *entry
}

func newLineLog() *lineLog {
	return &lineLog{
		nextSeq: 1, transientFrom: -1, cap: logCapBytes,
		replayPins: make(map[string][2]*entry), requests: make(map[string]replayRequest),
	}
}

// add appends one line and returns it with its sequence number.
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
	// Avoid decoding ordinary input and Codex requests, which can carry images.
	if bytes.Contains(message, []byte(`"control_request"`)) &&
		messageType(message) == "control_request" && l.trackReplayRequest(slot, message) {
		l.input = slot
		l.changePins(slot, 1)
	}
	return slot
}

// finishInput fills a reserved slot, if the log still includes it.
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

// addPinned appends a line the cap keeps. What it holds is bounded by
// whoever adds it.
func (l *lineLog) addPinned(dir string, message json.RawMessage) *entry {
	e := &entry{seq: l.nextSeq, dir: dir, message: message, at: time.Now().UnixMilli(), pins: 1}
	l.nextSeq++
	l.entries = append(l.entries, e)
	return e
}

// reset drops every line. Sequence numbers go on, so a client that saw
// the dropped lines does not take new ones for them.
func (l *lineLog) reset() {
	l.entries = nil
	l.bytes = 0
	l.truncated = false
	l.transientFrom = -1
	clear(l.replayPins)
	clear(l.requests)
	l.input, l.inputResponse = nil, nil
}

// lastSeq is the sequence number of the newest line, 0 when there is none.
func (l *lineLog) lastSeq() int64 {
	return l.nextSeq - 1
}

// since returns the lines after seq, oldest first.
func (l *lineLog) since(seq int64) []*entry {
	for i, e := range l.entries {
		if e.seq > seq {
			return l.entries[i:]
		}
	}
	return nil
}

// dropTransient removes the stream events of the messages written so far:
// each is now in the log whole.
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

// trim drops the oldest lines while the log is over its cap, always keeping
// the newest one and the pinned ones.
func (l *lineLog) trim() {
	if l.bytes <= l.cap {
		return
	}
	last := len(l.entries) - 1
	rest := make([]*entry, 0, cap(l.entries))
	// dropped counts the lines dropped before the first transient one.
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
		// The first transient line may itself have been dropped; starting
		// at a line before it is harmless.
		l.transientFrom -= dropped
		if l.transientFrom >= len(l.entries) {
			l.transientFrom = len(l.entries) - 1
		}
	}
}

// completesStream reports whether a line of this type ends the stream
// events before it: the message they were tokens of has arrived whole, or
// the turn ended.
func completesStream(kind string) bool {
	switch kind {
	case "assistant", "user", "result":
		return true
	}
	return false
}

// messageType reads a message's "type" without decoding the rest.
func messageType(message json.RawMessage) string {
	// Claude Code writes "type" first; read it there before decoding the
	// whole line, which can be megabytes of image data.
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

// readLine reads one line of at most limit bytes. A longer line is read to
// its end and dropped, with errLineTooLong.
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
