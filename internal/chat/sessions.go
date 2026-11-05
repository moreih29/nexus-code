package chat

// The sessions a folder has, for a Claude tab to go on with one: Claude Code
// keeps each session's transcript in its project's directory, which the
// folder's path names. Each is read as Claude Code's own session list reads
// it: the start of the file for what is set once (its first prompt, when it
// began), the end for what the session says last (its title, its last
// prompt, its branch).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// sessionsDefaultLimit is how many sessions a list has, newest first,
	// unless asked for fewer.
	sessionsDefaultLimit = 50
	sessionsMaxLimit     = 200
	// sessionReadBytes is how much of each end of a transcript is read.
	sessionReadBytes = 64 << 10
	// sessionTextMax caps a title or prompt, in characters.
	sessionTextMax = 200
	// projectNameMax is how long a project directory's name is before
	// Claude Code cuts it and adds a hash of the path.
	projectNameMax = 200
)

var notAlphanumeric = regexp.MustCompile(`[^a-zA-Z0-9]`)

// Sessions lists the sessions of a folder, newest first.
func (s *Service) Sessions(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionsParams
	if err := decodeParams(raw, &p, "chat.sessions params must include cwd"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" {
		return nil, protocolError("chat.sessions params must include cwd")
	}
	limit := p.Limit
	if limit <= 0 {
		limit = sessionsDefaultLimit
	}
	limit = min(limit, sessionsMaxLimit)
	dir := configDir(p.ConfigDir)
	if dir == "" {
		return SessionsResult{Sessions: []ClaudeSession{}}, nil
	}
	return SessionsResult{Sessions: listSessions(filepath.Join(dir, "projects"), p.Cwd, limit)}, nil
}

// listSessions reads the sessions of the folder `cwd` from `projects`.
func listSessions(projects, cwd string, limit int) []ClaudeSession {
	type file struct {
		id, path string
		modified time.Time
		size     int64
	}
	var files []file
	seen := map[string]bool{}
	for _, dir := range projectDirs(projects, cwd) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".jsonl")
			if !ok || entry.IsDir() || !sessionIDPattern.MatchString(id) || seen[id] {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			seen[id] = true
			files = append(files, file{id, filepath.Join(dir, entry.Name()), info.ModTime(), info.Size()})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if !files[i].modified.Equal(files[j].modified) {
			return files[i].modified.After(files[j].modified)
		}
		return files[i].id < files[j].id
	})
	sessions := []ClaudeSession{}
	for _, f := range files {
		if len(sessions) >= limit {
			break
		}
		info, ok := readClaudeSession(f.path)
		if !ok {
			continue
		}
		info.SessionID = f.id
		info.LastModified = f.modified.UnixMilli()
		info.Size = f.size
		sessions = append(sessions, info)
	}
	return sessions
}

// projectDirs are the directories that may hold the sessions of `cwd`:
// its path as Claude Code spells a project's name, as given and with its
// links resolved. A name too long is cut, and ends in a hash of the path.
func projectDirs(projects, cwd string) []string {
	paths := []string{filepath.Clean(cwd)}
	if real, err := filepath.EvalSymlinks(cwd); err == nil && real != paths[0] {
		paths = append(paths, real)
	}
	var dirs []string
	for _, path := range paths {
		name := notAlphanumeric.ReplaceAllString(path, "-")
		if len(name) <= projectNameMax {
			dirs = append(dirs, filepath.Join(projects, name))
			continue
		}
		matches, _ := filepath.Glob(filepath.Join(projects, globEscape(name[:projectNameMax])+"-*"))
		dirs = append(dirs, matches...)
	}
	return dirs
}

func globEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, "*", `\*`, "?", `\?`, "[", `\[`).Replace(s)
}

// readClaudeSession reads a transcript's title, prompts and branch; false for
// one that is a subagent's, or has nothing to show.
func readClaudeSession(path string) (ClaudeSession, bool) {
	head, tail, err := readEnds(path, sessionReadBytes)
	if err != nil {
		return ClaudeSession{}, false
	}
	var info ClaudeSession
	first := true
	var command string
	for _, line := range bytes.Split(head, []byte("\n")) {
		var entry transcriptEntry
		if json.Unmarshal(bytes.TrimSpace(line), &entry) != nil {
			continue
		}
		if first {
			first = false
			if entry.IsSidechain {
				return ClaudeSession{}, false
			}
		}
		if info.CreatedAt == 0 && entry.Timestamp != "" {
			if at, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
				info.CreatedAt = at.UnixMilli()
			}
		}
		if info.FirstPrompt == "" && entry.Type == "user" && !entry.IsMeta && !entry.IsCompactSummary {
			prompt, name := promptOf(entry.Message.Content)
			if prompt != "" {
				info.FirstPrompt = prompt
			} else if command == "" {
				command = name
			}
		}
	}
	info.CustomTitle = lastField(tail, head, "customTitle")
	// Outside a repository, or detached, the branch is told as HEAD: none.
	if branch := lastField(tail, nil, "gitBranch"); branch != "HEAD" {
		info.GitBranch = branch
	}
	title := firstOf(
		info.CustomTitle,
		lastField(tail, head, "aiTitle"),
		lastField(tail, nil, "lastPrompt"),
		info.FirstPrompt,
		command,
	)
	info.Title = oneLine(title)
	return info, info.Title != ""
}

func firstOf(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// transcriptEntry is what a transcript's line tells of the session.
type transcriptEntry struct {
	Type             string `json:"type"`
	Timestamp        string `json:"timestamp"`
	IsSidechain      bool   `json:"isSidechain"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	Message          struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

var commandName = regexp.MustCompile(`<command-name>\s*([^<]*?)\s*</command-name>`)

// promptOf is a user message's prompt: its text, unless it is one Claude Code
// writes itself (a tool's result, a command's output, a reminder), which
// starts with a tag. For a command, its name is told instead.
func promptOf(content json.RawMessage) (prompt, command string) {
	var text string
	if json.Unmarshal(content, &text) != nil {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(content, &blocks) != nil {
			return "", ""
		}
		for _, block := range blocks {
			if block.Type == "tool_result" {
				return "", ""
			}
			if block.Type == "text" && text == "" {
				text = block.Text
			}
		}
	}
	text = strings.TrimSpace(text)
	if m := commandName.FindStringSubmatch(text); m != nil {
		return "", m[1]
	}
	if text == "" || strings.HasPrefix(text, "<") || strings.HasPrefix(text, "[Request interrupted") {
		return "", ""
	}
	return oneLine(text), ""
}

// lastField is the last string `key` has in `text`, else in `fallback`: a
// title or prompt a session tells again as it goes, the last one standing.
func lastField(text, fallback []byte, key string) string {
	for _, part := range [][]byte{text, fallback} {
		marker := []byte(`"` + key + `":"`)
		for end := len(part); end > 0; {
			at := bytes.LastIndex(part[:end], marker)
			if at < 0 {
				break
			}
			if value, ok := jsonStringAt(part[at+len(marker)-1:]); ok && value != "" {
				return value
			}
			end = at
		}
	}
	return ""
}

// jsonStringAt decodes the JSON string `b` starts with.
func jsonStringAt(b []byte) (string, bool) {
	for i := 1; i < len(b); i++ {
		switch b[i] {
		case '\\':
			i++
		case '"':
			var s string
			if json.Unmarshal(b[:i+1], &s) != nil {
				return "", false
			}
			return s, true
		}
	}
	return "", false
}

// readEnds reads up to `n` bytes from each end of a file; all of it, as its
// head, when it is no bigger than both.
func readEnds(path string, n int64) (head, tail []byte, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if info.Size() <= 2*n {
		all, err := io.ReadAll(file)
		return all, all, err
	}
	head = make([]byte, n)
	if _, err := io.ReadFull(file, head); err != nil {
		return nil, nil, err
	}
	tail = make([]byte, n)
	if _, err := file.ReadAt(tail, info.Size()-n); err != nil {
		return nil, nil, err
	}
	return head, tail, nil
}

// oneLine is text on one line, cut to sessionTextMax characters.
func oneLine(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= sessionTextMax {
		return text
	}
	return string([]rune(text)[:sessionTextMax-1]) + "…"
}
