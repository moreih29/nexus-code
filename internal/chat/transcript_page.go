package chat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	transcriptPageBytes    = 512 * 1024
	transcriptPageTurns    = 20
	transcriptPageOverhead = 448
	transcriptReadBlock    = 64 * 1024
	transcriptAnchorBytes  = 2048
	transcriptSnapshots    = 128
)

type transcriptPageParams struct {
	TranscriptParams
	Cursor       string   `json:"cursor,omitempty"`
	BeforeAnchor string   `json:"beforeAnchor,omitempty"`
	UpTo         string   `json:"upTo,omitempty"`
	Before       []string `json:"before,omitempty"`
}

type transcriptPage struct {
	Found        bool                `json:"found"`
	Lines        []json.RawMessage   `json:"lines"`
	Positions    []int64             `json:"positions"`
	Truncated    bool                `json:"truncated"`
	Snapshot     string              `json:"snapshot,omitempty"`
	Cursor       string              `json:"cursor,omitempty"`
	BeforeAnchor string              `json:"beforeAnchor,omitempty"`
	Anchored     bool                `json:"anchored,omitempty"`
	CutMatched   bool                `json:"cutMatched"`
	Fragment     *transcriptFragment `json:"fragment,omitempty"`
}

type transcriptFragment struct {
	Position int64  `json:"position"`
	Data     []byte `json:"data"`
	First    bool   `json:"first"`
	Last     bool   `json:"last"`
}

type transcriptSnapshot struct {
	key                [32]byte
	session, dir, path string
	info               os.FileInfo
	floor, end         int64
	anchor             [32]byte
}

type transcriptSnapshotCache struct {
	mu      sync.Mutex
	entries [transcriptSnapshots]*transcriptSnapshot
	next    int
}

func (c *transcriptSnapshotCache) add(snapshot *transcriptSnapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[c.next] = snapshot
	c.next = (c.next + 1) % len(c.entries)
}

func (s *transcriptSnapshot) id() string {
	return base64.RawURLEncoding.EncodeToString(s.key[:16])
}

func (s *transcriptSnapshot) cursor(pos, fragment int64, anchor [32]byte) string {
	var token [80]byte
	copy(token[:16], s.key[:16])
	binary.BigEndian.PutUint64(token[16:24], uint64(pos))
	binary.BigEndian.PutUint64(token[24:32], uint64(fragment))
	copy(token[32:64], anchor[:])
	copy(token[64:], s.sign(token[:64]))
	return base64.RawURLEncoding.EncodeToString(token[:])
}

func (s *transcriptSnapshot) sign(data []byte) []byte {
	mac := hmac.New(sha256.New, s.key[16:])
	_, _ = mac.Write(data)
	return mac.Sum(nil)[:16]
}

func (c *transcriptSnapshotCache) decode(encoded string) (*transcriptSnapshot, int64, int64, [32]byte) {
	var anchor [32]byte
	if len(encoded) != base64.RawURLEncoding.EncodedLen(80) {
		return nil, 0, 0, anchor
	}
	token, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(token) != 80 {
		return nil, 0, 0, anchor
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, snapshot := range c.entries {
		if snapshot != nil && bytes.Equal(snapshot.key[:16], token[:16]) && hmac.Equal(snapshot.sign(token[:64]), token[64:]) {
			copy(anchor[:], token[32:64])
			return snapshot, int64(binary.BigEndian.Uint64(token[16:24])), int64(binary.BigEndian.Uint64(token[24:32])), anchor
		}
	}
	return nil, 0, 0, anchor
}

var errStaleTranscriptCursor = proto.NewError("chat.transcript-cursor-stale", "the transcript changed or its snapshot expired")

func (s *Service) TranscriptPage(ctx context.Context, raw json.RawMessage) (any, error) {
	var p transcriptPageParams
	if err := proto.DecodeParams(raw, &p, "chat.transcriptPage params must include sessionId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.SessionID) ||
		(p.Cursor != "" && p.BeforeAnchor != "") ||
		((p.Cursor != "" || p.BeforeAnchor != "") && (len(p.Before) > 0 || p.UpTo != "")) {
		return nil, proto.ProtocolError("invalid chat.transcriptPage params")
	}
	page, err := s.readTranscriptPage(ctx, p, transcriptCapBytes, transcriptPageBytes)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == errStaleTranscriptCursor {
			return nil, err
		}
		return nil, proto.RequestFailed("chat.transcriptPage: the transcript could not be read: %s", claudefiles.Reason(err))
	}
	return page, nil
}

func (s *Service) readTranscriptPage(ctx context.Context, p transcriptPageParams, retention int64, budget int) (transcriptPage, error) {
	page := transcriptPage{Lines: []json.RawMessage{}, Positions: []int64{}}
	if err := ctx.Err(); err != nil {
		return page, err
	}
	dir := configDir(p.ConfigDir)
	path, found := claudefiles.FindSession(dir, p.SessionID)
	var snapshot *transcriptSnapshot
	var pos, fragment int64
	var boundary [32]byte
	if p.Cursor != "" {
		snapshot, pos, fragment, boundary = s.transcriptPages.decode(p.Cursor)
		if snapshot == nil || snapshot.session != p.SessionID || snapshot.dir != dir || snapshot.path != path {
			return page, errStaleTranscriptCursor
		}
	}
	if path == "" {
		return page, nil
	}
	file, info, err := claudefiles.Open(path, found)
	if err != nil {
		if snapshot != nil && (os.IsNotExist(err) || errors.Is(err, claudefiles.ErrNotFoundFile)) {
			return page, errStaleTranscriptCursor
		}
		return page, err
	}
	defer file.Close()
	if snapshot == nil {
		snapshot = &transcriptSnapshot{session: p.SessionID, dir: dir, path: path, info: info, floor: max(0, info.Size()-retention), end: info.Size()}
		if _, err := rand.Read(snapshot.key[:]); err != nil {
			return page, err
		}
		snapshot.anchor, err = snapshotAnchor(file, snapshot.floor, info.Size())
		if err != nil {
			return page, err
		}
		if p.BeforeAnchor != "" {
			var matched bool
			snapshot.end, matched, err = transcriptEndBeforeAnchor(file, snapshot, p.BeforeAnchor)
			if err != nil || !matched {
				return page, err
			}
			page.Anchored = true
		} else if p.UpTo != "" || len(p.Before) > 0 {
			snapshot.end, page.CutMatched, err = transcriptCutEnd(ctx, file, snapshot, p)
			if err != nil {
				return page, err
			}
		}
		pos = snapshot.end
	} else {
		if err := snapshot.check(file, info); err != nil {
			return page, err
		}
		actual, err := cursorAnchor(file, snapshot, pos)
		if err != nil || actual != boundary {
			return page, errStaleTranscriptCursor
		}
	}
	page.Found = true
	page.Truncated = snapshot.floor > 0
	page.Snapshot = snapshot.id()
	scanner := transcriptReverseReader{ctx: ctx, file: file, floor: snapshot.floor}
	if fragment >= 0 && p.Cursor != "" {
		if pos, fragment, err = page.readFragment(&scanner, pos, fragment, budget, false); err != nil {
			return page, err
		}
	} else {
		if pos, fragment, err = page.readLines(&scanner, pos, budget); err != nil {
			return page, err
		}
	}
	if err := ctx.Err(); err != nil {
		return page, err
	}
	current, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return page, errStaleTranscriptCursor
	}
	if err != nil {
		return page, err
	}
	if err := snapshot.check(file, current); err != nil {
		return page, err
	}
	if pos > snapshot.floor {
		boundary, err := cursorAnchor(file, snapshot, pos)
		if err != nil {
			return page, err
		}
		page.Cursor = snapshot.cursor(pos, fragment, boundary)
		if fragment < 0 {
			page.BeforeAnchor, err = transcriptBeforeAnchor(file, pos, snapshot.end)
			if err != nil {
				return page, err
			}
		}
		if p.Cursor == "" {
			s.transcriptPages.add(snapshot)
		}
	}
	return page, nil
}

func (s *transcriptSnapshot) check(file *os.File, info os.FileInfo) error {
	if !os.SameFile(s.info, info) || info.Size() < s.info.Size() ||
		(info.Size() == s.info.Size() && info.ModTime() != s.info.ModTime()) {
		return errStaleTranscriptCursor
	}
	anchor, err := snapshotAnchor(file, s.floor, s.info.Size())
	if err != nil || anchor != s.anchor {
		return errStaleTranscriptCursor
	}
	return nil
}

func snapshotAnchor(file *os.File, floor, end int64) ([32]byte, error) {
	hash := sha256.New()
	for _, offset := range []int64{floor, max(floor, end-transcriptAnchorBytes)} {
		var buf [transcriptAnchorBytes]byte
		part := buf[:min(transcriptAnchorBytes, end-offset)]
		if _, err := file.ReadAt(part, offset); err != nil {
			return [32]byte{}, err
		}
		_, _ = hash.Write(part)
	}
	return [32]byte(hash.Sum(nil)), nil
}

func cursorAnchor(file *os.File, snapshot *transcriptSnapshot, pos int64) ([32]byte, error) {
	var buf [transcriptAnchorBytes]byte
	start := max(snapshot.floor, pos-transcriptAnchorBytes/2)
	part := buf[:min(transcriptAnchorBytes, snapshot.end-start)]
	_, err := file.ReadAt(part, start)
	return sha256.Sum256(part), err
}

const transcriptBeforeAnchorSize = 8 + 2 + sha256.Size

func transcriptBeforeAnchor(file *os.File, pos, end int64) (string, error) {
	var block [transcriptAnchorBytes]byte
	sample := block[:min(transcriptAnchorBytes, end-pos)]
	if _, err := file.ReadAt(sample, pos); err != nil {
		return "", err
	}
	var token [transcriptBeforeAnchorSize]byte
	binary.BigEndian.PutUint64(token[:8], uint64(pos))
	binary.BigEndian.PutUint16(token[8:10], uint16(len(sample)))
	digest := sha256.Sum256(sample)
	copy(token[10:], digest[:])
	return base64.RawURLEncoding.EncodeToString(token[:]), nil
}

func transcriptEndBeforeAnchor(file *os.File, snapshot *transcriptSnapshot, anchor string) (int64, bool, error) {
	if len(anchor) != base64.RawURLEncoding.EncodedLen(transcriptBeforeAnchorSize) {
		return 0, false, nil
	}
	token, err := base64.RawURLEncoding.DecodeString(anchor)
	if err != nil || len(token) != transcriptBeforeAnchorSize {
		return 0, false, nil
	}
	pos := int64(binary.BigEndian.Uint64(token[:8]))
	length := int64(binary.BigEndian.Uint16(token[8:10]))
	if pos <= 0 || pos < snapshot.floor || pos >= snapshot.end ||
		length <= 0 || length > transcriptAnchorBytes || length > snapshot.end-pos {
		return 0, false, nil
	}
	var block [transcriptAnchorBytes + 1]byte
	if _, err := file.ReadAt(block[:length+1], pos-1); err != nil {
		return 0, false, err
	}
	hash := sha256.Sum256(block[1 : length+1])
	return pos, block[0] == '\n' && bytes.Equal(hash[:], token[10:]), nil
}

func transcriptCutEnd(ctx context.Context, file *os.File, snapshot *transcriptSnapshot, p transcriptPageParams) (int64, bool, error) {
	reader := bufio.NewReaderSize(io.NewSectionReader(file, snapshot.floor, snapshot.end-snapshot.floor), transcriptReadBlock)
	before := make(map[string]bool, len(p.Before))
	for _, uuid := range p.Before {
		before[uuid] = true
	}
	pos := snapshot.floor
	for pos < snapshot.end {
		start := pos
		var line []byte
		for {
			if err := ctx.Err(); err != nil {
				return 0, false, err
			}
			chunk, err := reader.ReadSlice('\n')
			pos += int64(len(chunk))
			if start != snapshot.floor || snapshot.floor == 0 {
				line = append(line, chunk...)
			}
			if err != bufio.ErrBufferFull {
				if err != nil && err != io.EOF {
					return 0, false, err
				}
				break
			}
		}
		var entry struct {
			UUID       string `json:"uuid"`
			Attachment struct {
				Type   string  `json:"type"`
				Source *string `json:"source_uuid"`
			} `json:"attachment"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Attachment.Type == "queued_command" && entry.Attachment.Source != nil {
			entry.UUID = *entry.Attachment.Source
		}
		if before[entry.UUID] {
			return start, true, nil
		}
		if p.UpTo != "" && p.UpTo == entry.UUID {
			return pos, true, nil
		}
	}
	return snapshot.end, false, nil
}

type transcriptReverseReader struct {
	ctx            context.Context
	file           *os.File
	floor, blockAt int64
	block          []byte
}

func (r *transcriptReverseReader) blockBefore(pos int64) ([]byte, error) {
	if err := r.ctx.Err(); err != nil {
		return nil, err
	}
	if len(r.block) == 0 || pos <= r.blockAt || pos > r.blockAt+int64(len(r.block)) {
		r.blockAt = max(r.floor, pos-transcriptReadBlock)
		if r.block == nil {
			r.block = make([]byte, transcriptReadBlock)
		}
		r.block = r.block[:pos-r.blockAt]
		if _, err := r.file.ReadAt(r.block, r.blockAt); err != nil {
			return nil, err
		}
	}
	return r.block[:pos-r.blockAt], nil
}

func (r *transcriptReverseReader) previous(pos int64) (int64, int64, error) {
	block, err := r.blockBefore(pos)
	if err != nil {
		return 0, 0, err
	}
	end := pos
	if block[len(block)-1] == '\n' {
		end--
	}
	for at := end; at > r.floor; at = r.blockAt {
		block, err := r.blockBefore(at)
		if err != nil {
			return 0, 0, err
		}
		if lf := bytes.LastIndexByte(block, '\n'); lf >= 0 {
			return r.blockAt + int64(lf) + 1, end, nil
		}
	}
	return r.floor, end, nil
}

func (r *transcriptReverseReader) read(start, end int64) ([]byte, error) {
	if start >= r.blockAt && end <= r.blockAt+int64(len(r.block)) {
		return r.block[start-r.blockAt : end-r.blockAt], nil
	}
	data := make([]byte, end-start)
	for pos := start; pos < end; pos += transcriptReadBlock {
		if err := r.ctx.Err(); err != nil {
			return nil, err
		}
		part := data[pos-start : min(end, pos+transcriptReadBlock)-start]
		if _, err := r.file.ReadAt(part, pos); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func (p *transcriptPage) readLines(r *transcriptReverseReader, pos int64, budget int) (int64, int64, error) {
	remaining := budget - transcriptPageOverhead
	turns, turnRows, turnPos := 0, 0, int64(0)
	for pos > r.floor {
		start, end, err := r.previous(pos)
		if err != nil {
			return 0, 0, err
		}
		if start == r.floor && r.floor != 0 {
			pos = r.floor
			break
		}
		line, err := r.read(start, end)
		if err != nil {
			return 0, 0, err
		}
		line = bytes.TrimSpace(line)
		if !json.Valid(line) {
			pos = start
			continue
		}
		cost := len(line) + 24
		var wire []byte
		if cost <= remaining {
			wire, err = json.Marshal(json.RawMessage(line))
			if err != nil {
				return 0, 0, err
			}
			cost = len(wire) + 24
		}
		if cost > remaining {
			if len(p.Lines) == 0 {
				return p.readFragment(r, end, start, budget, true)
			}
			if turnRows > 0 {
				p.Lines = p.Lines[:turnRows]
				p.Positions = p.Positions[:turnRows]
				pos = turnPos
			}
			break
		}
		remaining -= cost
		p.Lines = append(p.Lines, wire)
		p.Positions = append(p.Positions, start)
		pos = start
		if transcriptTurnStart(line) {
			turns++
			turnRows, turnPos = len(p.Lines), pos
			if turns == transcriptPageTurns {
				break
			}
		}
	}
	for i, j := 0, len(p.Lines)-1; i < j; i, j = i+1, j-1 {
		p.Lines[i], p.Lines[j] = p.Lines[j], p.Lines[i]
		p.Positions[i], p.Positions[j] = p.Positions[j], p.Positions[i]
	}
	return pos, -1, nil
}

func (p *transcriptPage) readFragment(r *transcriptReverseReader, end, start int64, budget int, last bool) (int64, int64, error) {
	pos := max(start, end-int64((budget-transcriptPageOverhead)/4*3))
	data, err := r.read(pos, end)
	if err != nil {
		return 0, 0, err
	}
	p.Fragment = &transcriptFragment{Position: start, Data: bytes.Clone(data), First: pos == start, Last: last}
	if pos == start {
		return pos, -1, nil
	}
	return pos, start, nil
}

func transcriptTurnStart(line []byte) bool {
	var row struct {
		Type         string `json:"type"`
		IsSidechain  bool   `json:"isSidechain"`
		IsMeta       bool   `json:"isMeta"`
		PromptSource string `json:"promptSource"`
		Message      struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &row) != nil || row.Type != "user" || row.IsSidechain || row.IsMeta || row.PromptSource == "system" || len(row.Message.Content) == 0 {
		return false
	}
	if row.Message.Content[0] == '"' {
		return true
	}
	var blocks []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(row.Message.Content, &blocks) != nil || len(blocks) == 0 {
		return false
	}
	for _, block := range blocks {
		if block.Type == "tool_result" {
			return false
		}
	}
	return true
}
