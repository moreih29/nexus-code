package chat

import (
	"bytes"
	"encoding/json"
)

// entry is one line of a tab's log.
type entry struct {
	seq     int64
	dir     string
	message json.RawMessage
	text    string
	// transient marks a stream event: a token of a message still being
	// written. The complete message follows it, and then it is dropped.
	transient bool
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
}

func newLineLog() *lineLog {
	return &lineLog{nextSeq: 1, transientFrom: -1, cap: logCapBytes}
}

// add appends one line and returns it with its sequence number.
func (l *lineLog) add(dir string, message json.RawMessage, text string) *entry {
	e := &entry{seq: l.nextSeq, dir: dir, message: message, text: text}
	l.nextSeq++
	if dir == DirOut && message != nil {
		kind := messageType(message)
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
	l.trim()
	return e
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
// the newest one.
func (l *lineLog) trim() {
	drop := 0
	for l.bytes > l.cap && drop < len(l.entries)-1 {
		l.bytes -= l.entries[drop].size()
		drop++
	}
	if drop == 0 {
		return
	}
	l.truncated = true
	rest := make([]*entry, len(l.entries)-drop, cap(l.entries))
	copy(rest, l.entries[drop:])
	l.entries = rest
	if l.transientFrom >= 0 {
		l.transientFrom -= drop
		if l.transientFrom < 0 {
			l.transientFrom = 0
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
