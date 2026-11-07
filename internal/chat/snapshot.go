package chat

// What a Codex tab's files were before the session first changed them, for
// the tab to show a changed file's diff and put it back, as a Claude tab
// does with the original a Claude edit reports.
//
// Codex does not report the original. Its turn/diff/updated notification
// carries the turn's changes so far as a git diff, with each file's blob
// hashes before and after. When the file on disk still has the after hash,
// the diff applied in reverse gives the file before the turn, and the
// before hash proves it. The agent does this as the notification comes, so
// it is done once whether or not a client is connected, and logs the result
// where the log's cap does not drop it.

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// snapshotFileCap is the largest original kept of one file;
	// snapshotTotalCap what a tab keeps of all of them.
	snapshotFileCap  = 2 * 1024 * 1024
	snapshotTotalCap = 16 * 1024 * 1024

	// nullHash is git's hash for a side of a diff with no file.
	nullHash = "0000000000000000000000000000000000000000"

	diffMethod = "turn/diff/updated"
)

// snapshots follows one tab's turn diffs and takes each changed file's
// original once. Its methods are called with the session's lock held.
type snapshots struct {
	cwd string
	// roots are the folders a diff's paths may be from: the repository's
	// root when cwd is in one, and cwd. Found when first needed.
	roots []string
	files map[string]*fileState
	bytes int
}

// fileState is what is known of one file a diff named.
type fileState struct {
	// oldHash is the file's hash before the first turn that changed it.
	// Only a diff from that hash gives the session's original.
	oldHash string
	done    bool
}

func newSnapshots(cwd string) *snapshots {
	return &snapshots{cwd: cwd, files: make(map[string]*fileState)}
}

// snapshot is one file's original, as the agent logs it: its absolute
// path, and its text before the session changed it; nil when the session
// wrote it new.
type snapshot struct {
	Event  string  `json:"event"`
	Path   string  `json:"path"`
	Before *string `json:"before"`
}

// take reads one line the program wrote and returns the originals it lets
// the agent take: none unless it is a turn diff.
func (s *snapshots) take(line []byte) []snapshot {
	if !bytes.Contains(line, []byte(`"`+diffMethod+`"`)) {
		return nil
	}
	var message struct {
		Method string `json:"method"`
		Params struct {
			Diff string `json:"diff"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &message) != nil || message.Method != diffMethod {
		return nil
	}
	var taken []snapshot
	for _, file := range parseDiff(message.Params.Diff) {
		// A moved file is left out: putting it back is more than writing
		// its old text.
		if file.oldPath != "" && file.newPath != "" && file.oldPath != file.newPath {
			continue
		}
		name := file.oldPath
		if name == "" {
			name = file.newPath
		}
		if name == "" {
			continue
		}
		state := s.files[name]
		if state == nil {
			state = &fileState{oldHash: file.oldHash}
			s.files[name] = state
		}
		// A later turn's diff starts from the file as an earlier turn left it.
		if state.done || file.oldHash != state.oldHash {
			continue
		}
		snap, final := s.original(name, file)
		if final {
			state.done = true
		}
		if snap != nil {
			taken = append(taken, *snap)
		}
	}
	return taken
}

// original works out a file's text before the diff. final reports that
// there is no use trying again: it was taken, or it cannot be. Otherwise
// the file has changed again since the diff, and the next diff may match.
func (s *snapshots) original(name string, file fileDiff) (snap *snapshot, final bool) {
	if file.oldHash == "" || file.newHash == "" {
		// Only a mode changed, or the diff is not one Codex writes.
		return nil, true
	}
	if isNullHash(file.oldHash) || file.oldPath == "" {
		// Written new: there was no file.
		return &snapshot{Event: "snapshot", Path: s.pathIn(s.rootsOf()[0], name)}, true
	}
	if isNullHash(file.newHash) || file.newPath == "" {
		// Deleted: the diff holds all of it.
		before, ok := file.before("")
		if !ok || !hashMatches(blobHash(before), file.oldHash) {
			return nil, true
		}
		return s.keep(s.pathIn(s.rootsOf()[0], name), before)
	}
	for _, root := range s.rootsOf() {
		path := s.pathIn(root, name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if info.Size() > 2*snapshotFileCap {
			return nil, true
		}
		data, err := os.ReadFile(path)
		if err != nil || !hashMatches(blobHash(string(data)), file.newHash) {
			continue
		}
		before, ok := file.before(string(data))
		if !ok || !hashMatches(blobHash(before), file.oldHash) {
			return nil, true
		}
		return s.keep(path, before)
	}
	return nil, false
}

// keep takes a file's original if it is text and fits.
func (s *snapshots) keep(path, before string) (*snapshot, bool) {
	if len(before) > snapshotFileCap || s.bytes+len(before) > snapshotTotalCap ||
		!utf8.ValidString(before) {
		return nil, true
	}
	s.bytes += len(before)
	return &snapshot{Event: "snapshot", Path: path, Before: &before}, true
}

// rootsOf returns the folders a diff's paths may be from. Codex writes
// them from the repository's root, or from its folder outside one.
func (s *snapshots) rootsOf() []string {
	if s.roots == nil {
		s.roots = []string{s.cwd}
		if root := repoRoot(s.cwd); root != "" && root != filepath.Clean(s.cwd) {
			s.roots = []string{root, s.cwd}
		}
	}
	return s.roots
}

func (s *snapshots) pathIn(root, name string) string {
	name = filepath.FromSlash(name)
	if filepath.IsAbs(name) {
		return filepath.Clean(name)
	}
	return filepath.Join(root, name)
}

// repoRoot is the folder of the git repository dir is in, "" outside one.
func repoRoot(dir string) string {
	dir = filepath.Clean(dir)
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// blobHash is the hash git gives a file of this content.
func blobHash(content string) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(content))
	_, _ = io.WriteString(h, content)
	return hex.EncodeToString(h.Sum(nil))
}

// hashMatches compares a full hash with one a diff gives, which may be
// shortened.
func hashMatches(full, given string) bool {
	return len(given) >= 7 && strings.HasPrefix(full, strings.ToLower(given))
}

func isNullHash(hash string) bool {
	return hash != "" && strings.Trim(hash, "0") == ""
}

// fileDiff is one file of a git diff: its paths ("" for /dev/null), its
// blob hashes before and after, and its hunks.
type fileDiff struct {
	oldPath, newPath string
	oldHash, newHash string
	hunks            []hunk
}

type hunk struct {
	newStart, newLines int
	lines              []hunkLine
	// oldLeft and newLeft count the lines still to come.
	oldLeft, newLeft int
}

// hunkLine is one line of a hunk: ' ', '-' or '+', and the line with its
// ending, which it has unless git marked it "\ No newline at end of file".
type hunkLine struct {
	op   byte
	text string
}

// parseDiff reads a git diff. A line's ending is kept as the file has it,
// so a CRLF file's lines end in "\r\n".
func parseDiff(diff string) []fileDiff {
	var files []fileDiff
	lines := strings.Split(diff, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	var file *fileDiff
	var current *hunk
	for _, line := range lines {
		if strings.HasPrefix(line, "diff --git ") {
			files = append(files, fileDiff{})
			file = &files[len(files)-1]
			current = nil
			continue
		}
		if file == nil {
			continue
		}
		if current != nil && (current.oldLeft > 0 || current.newLeft > 0) {
			if line == "" {
				// A blank line whose leading space was lost.
				line = " "
			}
			op := line[0]
			if op != ' ' && op != '-' && op != '+' {
				if op == '\\' {
					trimEnding(current)
					continue
				}
				current = nil
				continue
			}
			current.lines = append(current.lines, hunkLine{op: op, text: line[1:] + "\n"})
			if op != '+' {
				current.oldLeft--
			}
			if op != '-' {
				current.newLeft--
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, `\`) && current != nil:
			trimEnding(current)
		case strings.HasPrefix(line, "@@ "):
			h, ok := parseHunkHeader(line)
			if !ok {
				current = nil
				continue
			}
			file.hunks = append(file.hunks, h)
			current = &file.hunks[len(file.hunks)-1]
		case current == nil && strings.HasPrefix(line, "index "):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				file.oldHash, file.newHash, _ = strings.Cut(fields[1], "..")
			}
		case current == nil && strings.HasPrefix(line, "--- "):
			file.oldPath = diffPath(line[4:], "a/")
		case current == nil && strings.HasPrefix(line, "+++ "):
			file.newPath = diffPath(line[4:], "b/")
		}
	}
	return files
}

// trimEnding marks a hunk's last line as having no line ending.
func trimEnding(h *hunk) {
	if n := len(h.lines); n > 0 {
		h.lines[n-1].text = strings.TrimSuffix(h.lines[n-1].text, "\n")
	}
}

// parseHunkHeader reads "@@ -a,b +c,d @@".
func parseHunkHeader(line string) (hunk, bool) {
	fields := strings.Fields(line)
	if len(fields) < 4 || fields[0] != "@@" || fields[3] != "@@" {
		return hunk{}, false
	}
	_, oldLines, ok1 := hunkRange(fields[1], '-')
	newStart, newLines, ok2 := hunkRange(fields[2], '+')
	if !ok1 || !ok2 {
		return hunk{}, false
	}
	return hunk{newStart: newStart, newLines: newLines, oldLeft: oldLines, newLeft: newLines}, true
}

// hunkRange reads "-a,b" or "+c" (one line).
func hunkRange(field string, sign byte) (start, count int, ok bool) {
	if len(field) < 2 || field[0] != sign {
		return 0, 0, false
	}
	first, second, two := strings.Cut(field[1:], ",")
	start, err := strconv.Atoi(first)
	if err != nil || start < 0 {
		return 0, 0, false
	}
	count = 1
	if two {
		count, err = strconv.Atoi(second)
		if err != nil || count < 0 {
			return 0, 0, false
		}
	}
	return start, count, true
}

// diffPath reads a path from a "---" or "+++" line: "" for /dev/null, and
// a name git quoted unquoted.
func diffPath(text, prefix string) string {
	text = strings.TrimSuffix(text, "\t")
	if strings.HasPrefix(text, `"`) {
		if unquoted, err := strconv.Unquote(text); err == nil {
			text = unquoted
		}
	}
	if text == "/dev/null" {
		return ""
	}
	return strings.TrimPrefix(text, prefix)
}

// before applies the diff in reverse to the file it made. ok is false when
// the file does not have the lines the diff says it made.
func (f *fileDiff) before(after string) (string, bool) {
	lines := splitLines(after)
	var out strings.Builder
	pos := 0
	for _, h := range f.hunks {
		if h.oldLeft != 0 || h.newLeft != 0 {
			return "", false
		}
		// A hunk that adds nothing names the line it follows.
		start := h.newStart - 1
		if h.newLines == 0 {
			start = h.newStart
		}
		if start < pos || start > len(lines) {
			return "", false
		}
		for ; pos < start; pos++ {
			out.WriteString(lines[pos])
		}
		for _, line := range h.lines {
			if line.op == '-' {
				out.WriteString(line.text)
				continue
			}
			if pos >= len(lines) || lines[pos] != line.text {
				return "", false
			}
			if line.op == ' ' {
				out.WriteString(line.text)
			}
			pos++
		}
	}
	for ; pos < len(lines); pos++ {
		out.WriteString(lines[pos])
	}
	return out.String(), true
}

// splitLines splits text after each "\n"; the last line may have none.
func splitLines(text string) []string {
	var lines []string
	for text != "" {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			lines = append(lines, text)
			break
		}
		lines = append(lines, text[:i+1])
		text = text[i+1:]
	}
	return lines
}
