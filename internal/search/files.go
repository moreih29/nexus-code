package search

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"unicode"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	defaultFilesLimit = 50
	maxFilesLimit     = 1000
	// maxFilesWalked bounds one search.files walk: a home folder opened as
	// a workspace must not keep the agent busy for minutes.
	maxFilesWalked = 200_000
)

// FilesParams asks for the files whose paths hold Query's characters in order.
type FilesParams struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

// FilesResult lists the best matches first, relative to the root with "/"
// between parts. Truncated: the walk stopped before every file was seen.
type FilesResult struct {
	Files     []string `json:"files"`
	Truncated bool     `json:"truncated"`
}

type scoredFile struct {
	path  string
	score int
}

// Files finds files by name as quick open does: the folders text search
// leaves out (hiddenNames, and the build folders of defaultExcludes) are left
// out here too, but any regular file is a candidate, binary or empty.
func (s *Service) Files(ctx context.Context, raw json.RawMessage) (any, error) {
	var p FilesParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("search.files params must include query")
	}
	query := foldQuery(p.Query)
	if len(query) == 0 {
		return nil, proto.ProtocolError("search.files query is required")
	}
	limit := p.Limit
	if limit <= 0 {
		limit = defaultFilesLimit
	}
	limit = min(limit, maxFilesLimit)
	excluded := buildExcludePredicates(defaultExcludes)

	best := make([]scoredFile, 0, limit)
	walked := 0
	truncated := false
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
			if _, hidden := hiddenNames[name]; hidden || excluded.matchesDir(name) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if _, hidden := hiddenNames[name]; hidden {
			return nil
		}
		walked++
		if walked > maxFilesWalked {
			truncated = true
			return filepath.SkipAll
		}
		rel, err := filepath.Rel(s.root, abs)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		score, ok := fuzzyScore(rel, query)
		if !ok {
			return nil
		}
		best = keepBest(best, scoredFile{path: rel, score: score}, limit)
		return nil
	})
	if err != nil {
		return nil, err
	}
	files := make([]string, len(best))
	for i, f := range best {
		files[i] = f.path
	}
	return FilesResult{Files: files, Truncated: truncated}, nil
}

// foldQuery lowercases the query and drops its spaces; a "\" is taken as "/".
func foldQuery(q string) []rune {
	out := make([]rune, 0, len(q))
	for _, r := range q {
		if unicode.IsSpace(r) {
			continue
		}
		if r == '\\' {
			r = '/'
		}
		out = append(out, unicode.ToLower(r))
	}
	return out
}

// before reports whether a ranks ahead of b: a higher score, then a shorter
// path, then by name.
func before(a, b scoredFile) bool {
	if a.score != b.score {
		return a.score > b.score
	}
	if len(a.path) != len(b.path) {
		return len(a.path) < len(b.path)
	}
	return a.path < b.path
}

// keepBest inserts f into best, which stays sorted and at most limit long.
func keepBest(best []scoredFile, f scoredFile, limit int) []scoredFile {
	if len(best) == limit && !before(f, best[len(best)-1]) {
		return best
	}
	at := sort.Search(len(best), func(i int) bool { return before(f, best[i]) })
	if len(best) < limit {
		best = append(best, scoredFile{})
	}
	copy(best[at+1:], best[at:len(best)-1])
	best[at] = f
	return best
}

const (
	scoreMatch       = 1
	scoreConsecutive = 6
	scoreWordStart   = 8
	scorePartStart   = 10
	// A gap between two matched characters costs gapStart, and gapExtend
	// more for each character it skips.
	gapStart  = 3
	gapExtend = 1
	// scoreInName puts every file whose name holds the query ahead of those
	// that hold it only across their folders, as quick open does.
	scoreInName       = 1 << 20
	scoreUnmatched    = -1 << 30
	maxScoredPathRune = 512
)

// fuzzyScore scores path against query (folded by foldQuery): its
// characters in order, in the file name if they are all there, best placed
// together and at the start of words. ok is false when they are not all in
// path.
func fuzzyScore(path string, query []rune) (int, bool) {
	target := []rune(path)
	if len(target) > maxScoredPathRune || len(query) > len(target) {
		return 0, false
	}
	nameStart := 0
	for i, r := range target {
		if r == '/' {
			nameStart = i + 1
		}
	}
	if score, ok := subsequenceScore(target[nameStart:], query); ok {
		return scoreInName + score, true
	}
	return subsequenceScore(target, query)
}

// subsequenceScore is the best score of query's characters in order in
// target, or ok false when they are not all in it.
func subsequenceScore(target []rune, query []rune) (int, bool) {
	if len(query) > len(target) {
		return 0, false
	}
	lower := make([]rune, len(target))
	for i, r := range target {
		lower[i] = unicode.ToLower(r)
	}
	// Cheap check first: most paths do not hold the query at all.
	next := 0
	for _, r := range lower {
		if next < len(query) && r == query[next] {
			next++
		}
	}
	if next < len(query) {
		return 0, false
	}

	bonus := func(j int) int {
		switch {
		case j == 0 || target[j-1] == '/':
			return scoreMatch + scorePartStart
		case isSeparator(target[j-1]):
			return scoreMatch + scoreWordStart
		case unicode.IsUpper(target[j]) && unicode.IsLower(target[j-1]):
			return scoreMatch + scoreWordStart
		}
		return scoreMatch
	}

	// prev[j]: the best score of the query so far with its last character at j.
	prev := make([]int, len(target))
	cur := make([]int, len(target))
	for j := range prev {
		prev[j] = scoreUnmatched
		if lower[j] == query[0] {
			prev[j] = bonus(j)
		}
	}
	for i := 1; i < len(query); i++ {
		// jump: the best score of the query so far ending before j-1, its gap to j paid.
		jump := scoreUnmatched
		for j := range target {
			cur[j] = scoreUnmatched
			if j == 0 {
				continue
			}
			if jump != scoreUnmatched {
				jump -= gapExtend
			}
			if prev[j-1] != scoreUnmatched {
				jump = max(jump, prev[j-1]-gapStart)
			}
			if lower[j] != query[i] {
				continue
			}
			if jump != scoreUnmatched {
				cur[j] = jump + bonus(j)
			}
			if prev[j-1] != scoreUnmatched {
				cur[j] = max(cur[j], prev[j-1]+bonus(j)+scoreConsecutive)
			}
		}
		prev, cur = cur, prev
	}
	best := scoreUnmatched
	for _, s := range prev {
		best = max(best, s)
	}
	return best, best != scoreUnmatched
}

func isSeparator(r rune) bool {
	switch r {
	case '/', '_', '-', '.', ' ':
		return true
	}
	return false
}
