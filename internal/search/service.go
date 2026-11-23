package search

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/content"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	defaultMaxResults   = 2000
	defaultMaxFileSize  = 5 * 1024 * 1024
	maxSearchFileSize   = 16 * 1024 * 1024
	batchCountTrigger   = 50
	batchMatchesTrigger = 200
	batchTimeTrigger    = 30 * time.Millisecond
	perFileMatchCap     = 1000
	earlyCancelLifetime = 30 * time.Second
	maxEarlyCancels     = 1024

	previewMaxBytes     = 512
	previewContextBytes = 64
)

var hiddenNames = map[string]struct{}{
	".git": {}, "node_modules": {}, "dist": {}, "out": {}, ".DS_Store": {},
	".next": {}, ".turbo": {}, ".cache": {}, ".vscode-test": {},
}

var defaultExcludes = []string{
	"*.lock", "*-lock.json", "*.lockb", "bun.lock", "*.min.js", "*.min.css",
	"*.map", "build/", "coverage/", "target/",
}

type EventSink func(event string, payload any) error

type Service struct {
	root string

	mu           sync.Mutex
	sink         EventSink
	cancels      map[string]context.CancelFunc
	earlyCancels map[string]time.Time
}

type Params struct {
	SearchID string `json:"searchId"`
	Query    Query  `json:"query"`
}

type CancelParams struct {
	SearchID string `json:"searchId"`
}

type Query struct {
	Pattern         string   `json:"pattern"`
	IsRegExp        bool     `json:"isRegExp"`
	IsCaseSensitive bool     `json:"isCaseSensitive"`
	IsWordMatch     bool     `json:"isWordMatch"`
	Includes        []string `json:"includes"`
	Excludes        []string `json:"excludes"`
	MaxResults      int      `json:"maxResults"`
	MaxFileSize     int64    `json:"maxFileSize"`
}

type Range struct {
	Line     int `json:"line"`
	StartCol int `json:"startCol"`
	EndCol   int `json:"endCol"`
}

type Match struct {
	Range        Range  `json:"range"`
	Preview      string `json:"preview"`
	PreviewStart int    `json:"previewStart,omitempty"`
}

type FileMatch struct {
	RelPath string  `json:"relPath"`
	Matches []Match `json:"matches"`
}

type ProgressPayload struct {
	SearchID string      `json:"searchId"`
	Batch    []FileMatch `json:"batch"`
}

type Complete struct {
	FilesScanned int   `json:"filesScanned"`
	MatchesFound int   `json:"matchesFound"`
	LimitHit     bool  `json:"limitHit"`
	ElapsedMs    int64 `json:"elapsedMs"`
}

type excludePredicate struct {
	dirNames    []string
	extSuffixes []string
	exactNames  []string
}

type batchState struct {
	pending           []FileMatch
	matchesFound      int
	matchesSinceFlush int
	lastFlush         time.Time
	limitHit          bool
}

func New(root string) (*Service, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Service{
		root: filepath.Clean(abs), cancels: make(map[string]context.CancelFunc),
		earlyCancels: make(map[string]time.Time),
	}, nil
}

func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("search.text", service.Text)
	d.Register("search.cancel", service.Cancel)
	d.Register("search.files", service.Files)
}

func (s *Service) Text(ctx context.Context, raw json.RawMessage) (any, error) {
	var p Params
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("search.text params must include searchId and query")
	}
	if p.SearchID == "" {
		return nil, proto.ProtocolError("search.text searchId is required")
	}
	searchCtx, finish, err := s.registerSearch(ctx, p.SearchID)
	if err != nil {
		return nil, err
	}
	defer finish()
	if p.Query.MaxFileSize > maxSearchFileSize {
		return nil, proto.ProtocolError("search.text maxFileSize must be at most 16 MiB")
	}
	normalizeQuery(&p.Query)
	re, err := compilePattern(p.Query)
	if err != nil {
		return nil, err
	}
	if err := searchCtx.Err(); err != nil {
		return nil, err
	}

	start := time.Now()
	result, err := s.walk(searchCtx, p.SearchID, p.Query, re)
	if err != nil {
		return nil, err
	}
	result.ElapsedMs = time.Since(start).Milliseconds()
	return result, nil
}

func (s *Service) registerSearch(ctx context.Context, id string) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if expiry, ok := s.earlyCancels[id]; ok {
		delete(s.earlyCancels, id)
		if time.Now().Before(expiry) {
			return nil, nil, context.Canceled
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if s.cancels[id] != nil {
		return nil, nil, proto.ProtocolError("search.text searchId is already running")
	}
	searchCtx, cancel := context.WithCancel(ctx)
	s.cancels[id] = cancel
	return searchCtx, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		cancel()
		delete(s.cancels, id)
	}, nil
}

func (s *Service) Cancel(_ context.Context, raw json.RawMessage) (any, error) {
	var p CancelParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || p.SearchID == "" {
		return nil, proto.ProtocolError("search.cancel params must include searchId")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel := s.cancels[p.SearchID]; cancel != nil {
		cancel()
	} else {
		s.rememberCancel(p.SearchID, time.Now())
	}
	return struct{}{}, nil
}

func (s *Service) rememberCancel(id string, now time.Time) {
	var oldestID string
	var oldest time.Time
	for key, expiry := range s.earlyCancels {
		if !now.Before(expiry) {
			delete(s.earlyCancels, key)
			continue
		}
		if oldest.IsZero() || expiry.Before(oldest) {
			oldestID, oldest = key, expiry
		}
	}
	if len(s.earlyCancels) >= maxEarlyCancels && s.earlyCancels[id].IsZero() {
		delete(s.earlyCancels, oldestID)
	}
	s.earlyCancels[id] = now.Add(earlyCancelLifetime)
}

func normalizeQuery(q *Query) {
	if q.MaxResults <= 0 {
		q.MaxResults = defaultMaxResults
	}
	if q.MaxFileSize <= 0 {
		q.MaxFileSize = defaultMaxFileSize
	}
}

func compilePattern(q Query) (*regexp.Regexp, error) {
	src := q.Pattern
	if src == "" {
		return nil, proto.ProtocolError("search.text query.pattern is required")
	}
	if !q.IsRegExp {
		src = regexp.QuoteMeta(src)
	}
	if q.IsWordMatch {
		leading := !strings.HasPrefix(src, `\B`)
		trailing := !strings.HasSuffix(src, `\B`)
		src = fmt.Sprintf("%s%s%s", ternary(leading, `\b`, ""), src, ternary(trailing, `\b`, ""))
	}
	if !q.IsCaseSensitive {
		src = "(?i)" + src
	}
	re, err := regexp.Compile(src)
	if err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf("Invalid search pattern %q: %s", q.Pattern, err.Error())}
	}
	return re, nil
}

func ternary(ok bool, yes string, no string) string {
	if ok {
		return yes
	}
	return no
}

func (s *Service) walk(ctx context.Context, searchID string, q Query, re *regexp.Regexp) (Complete, error) {
	defaultExclude := buildExcludePredicates(defaultExcludes)
	userExclude := buildExcludePredicates(q.Excludes)
	include := buildIncludePredicate(q.Includes)
	state := batchState{lastFlush: time.Now()}
	filesScanned := 0

	err := filepath.WalkDir(s.root, func(abs string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if abs == s.root {
			return nil
		}

		name := entry.Name()
		if entry.IsDir() {
			if _, hidden := hiddenNames[name]; hidden {
				return filepath.SkipDir
			}
			if defaultExclude.matchesDir(name) || userExclude.matchesDir(name) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if defaultExclude.matchesFile(name) || userExclude.matchesFile(name) {
			return nil
		}
		if include != nil && !include(name) {
			return nil
		}

		info, err := entry.Info()
		if err != nil || info.Size() == 0 || info.Size() > q.MaxFileSize {
			return nil
		}
		buf, err := readForSearch(ctx, abs, info.Size())
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil || buf == nil {
			return nil
		}
		filesScanned++

		rel, err := filepath.Rel(s.root, abs)
		if err != nil {
			return nil
		}
		matches := findMatches(buf, re, perFileMatchCap, q.MaxResults-state.matchesFound)
		if len(matches) == 0 {
			return nil
		}
		state.pending = append(state.pending, FileMatch{RelPath: filepath.ToSlash(rel), Matches: matches})
		state.matchesFound += len(matches)
		state.matchesSinceFlush += len(matches)

		if state.matchesFound >= q.MaxResults {
			state.limitHit = true
			s.emitBatch(searchID, &state)
			return errSearchLimit
		}
		if shouldFlush(state) {
			s.emitBatch(searchID, &state)
		}
		return nil
	})
	if err != nil && !errorsIsSearchLimit(err) {
		return Complete{}, err
	}
	if err := ctx.Err(); err != nil {
		return Complete{}, err
	}
	s.emitBatch(searchID, &state)

	return Complete{FilesScanned: filesScanned, MatchesFound: state.matchesFound, LimitHit: state.limitHit}, nil
}

var errSearchLimit = fmt.Errorf("search limit reached")

func errorsIsSearchLimit(err error) bool {
	return err == errSearchLimit
}

func shouldFlush(state batchState) bool {
	return len(state.pending) >= batchCountTrigger ||
		state.matchesSinceFlush >= batchMatchesTrigger ||
		time.Since(state.lastFlush) >= batchTimeTrigger
}

func (s *Service) emitBatch(searchID string, state *batchState) {
	if len(state.pending) == 0 {
		return
	}
	batch := append([]FileMatch(nil), state.pending...)
	state.pending = state.pending[:0]
	state.matchesSinceFlush = 0
	state.lastFlush = time.Now()

	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink != nil {
		_ = sink("search.progress", ProgressPayload{SearchID: searchID, Batch: batch})
	}
}

func readForSearch(ctx context.Context, abs string, size int64) ([]byte, error) {
	file, err := os.Open(abs)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	probeLen := int64(content.BinaryProbeBytes)
	if size < probeLen {
		probeLen = size
	}
	probe := make([]byte, probeLen)
	n, err := io.ReadFull(searchReader{ctx, file}, probe)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	probe = probe[:n]
	if content.IsBinaryProbe(probe) {
		return nil, nil
	}
	if size <= int64(content.BinaryProbeBytes) {
		return probe, nil
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(searchReader{ctx, file}, size))
}

type searchReader struct {
	ctx    context.Context
	source io.Reader
}

func (r searchReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(p[:min(len(p), 32<<10)])
}

func findMatches(buf []byte, re *regexp.Regexp, perFileCap int, remainingGlobal int) []Match {
	if remainingGlobal <= 0 || content.IsBinaryProbe(prefix(buf, content.BinaryProbeBytes)) {
		return nil
	}
	text := string(buf)
	if strings.HasPrefix(text, "\ufeff") {
		text = strings.TrimPrefix(text, "\ufeff")
	}
	limit := min(perFileCap, remainingGlobal)
	lines := splitLines(text)
	out := make([]Match, 0)
	for lineIndex, line := range lines {
		indexes := re.FindAllStringIndex(line, limit-len(out))
		cols := utf16Cols{line: line}
		for _, pair := range indexes {
			preview, previewFrom := matchPreview(line, pair[0])
			startCol := cols.at(pair[0])
			out = append(out, Match{
				Range:        Range{Line: lineIndex, StartCol: startCol, EndCol: cols.at(pair[1])},
				Preview:      preview,
				PreviewStart: startCol - utf16Len(line[previewFrom:pair[0]]),
			})
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func matchPreview(line string, start int) (string, int) {
	if len(line) <= previewMaxBytes {
		return line, 0
	}
	from := max(start-previewContextBytes, 0)
	for from < start && !utf8.RuneStart(line[from]) {
		from++
	}
	to := min(from+previewMaxBytes, len(line))
	for to > from && to < len(line) && !utf8.RuneStart(line[to]) {
		to--
	}
	return line[from:to], from
}

type utf16Cols struct {
	line    string
	byteOff int
	col     int
}

func (c *utf16Cols) at(byteOff int) int {
	c.col += utf16Len(c.line[c.byteOff:byteOff])
	c.byteOff = byteOff
	return c.col
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func prefix(buf []byte, n int) []byte {
	if len(buf) <= n {
		return buf
	}
	return buf[:n]
}

var lineBreak = regexp.MustCompile(`\r\n|\n|\r`)

func splitLines(text string) []string {
	return lineBreak.Split(text, -1)
}

func buildExcludePredicates(patterns []string) excludePredicate {
	p := excludePredicate{}
	for _, pattern := range patterns {
		switch {
		case strings.HasSuffix(pattern, "/"):
			p.dirNames = append(p.dirNames, strings.TrimSuffix(pattern, "/"))
		case strings.HasPrefix(pattern, "*."):
			p.extSuffixes = append(p.extSuffixes, strings.TrimPrefix(pattern, "*"))
		default:
			p.exactNames = append(p.exactNames, pattern)
		}
	}
	return p
}

func (p excludePredicate) matchesDir(name string) bool {
	return contains(p.dirNames, name)
}

func (p excludePredicate) matchesFile(name string) bool {
	if contains(p.exactNames, name) {
		return true
	}
	for _, suffix := range p.extSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

func buildIncludePredicate(patterns []string) func(string) bool {
	if len(patterns) == 0 {
		return nil
	}
	p := buildExcludePredicates(patterns)
	return func(name string) bool {
		return p.matchesFile(name)
	}
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
