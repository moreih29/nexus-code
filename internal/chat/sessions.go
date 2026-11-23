package chat

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

	"github.com/nexus-code/nexus-code/internal/claudefiles"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	sessionsDefaultLimit = 50
	sessionsMaxLimit     = 200
	sessionReadBytes     = 64 << 10
	sessionTextMax       = 200
	projectNameMax       = 200
)

var notAlphanumeric = regexp.MustCompile(`[^a-zA-Z0-9]`)

func (s *Service) Sessions(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionsParams
	if err := proto.DecodeParams(raw, &p, "chat.sessions params must include cwd"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" {
		return nil, proto.ProtocolError("chat.sessions params must include cwd")
	}
	limit := p.Limit
	if limit <= 0 {
		limit = sessionsDefaultLimit
	}
	limit = min(limit, sessionsMaxLimit)
	return SessionsResult{Sessions: listSessions(claudefiles.ProjectsDir(configDir(p.ConfigDir)), p.Cwd, limit)}, nil
}

func listSessions(projects, cwd string, limit int) []ClaudeSession {
	type file struct {
		id, path string
		info     os.FileInfo
	}
	var files []file
	seen := map[string]bool{}
	for _, dir := range claudeProjectFoldersFor(projects, cwd) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".jsonl")
			if !ok || !sessionIDPattern.MatchString(id) || seen[id] {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			info, ok := claudefiles.RegularFile(path)
			if !ok {
				continue
			}
			seen[id] = true
			files = append(files, file{id, path, info})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		a, b := files[i].info.ModTime(), files[j].info.ModTime()
		if !a.Equal(b) {
			return a.After(b)
		}
		return files[i].id < files[j].id
	})
	sessions := []ClaudeSession{}
	for _, f := range files {
		if len(sessions) >= limit {
			break
		}
		info, ok := readClaudeSession(projects, f.path, f.info)
		if !ok {
			continue
		}
		info.SessionID = f.id
		info.LastModified = f.info.ModTime().UnixMilli()
		info.Size = f.info.Size()
		sessions = append(sessions, info)
	}
	return sessions
}

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

func readClaudeSession(projects, path string, want os.FileInfo) (ClaudeSession, bool) {
	head, tail, err := readEnds(projects, path, want, sessionReadBytes)
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

func readEnds(projects, path string, want os.FileInfo, n int64) (head, tail []byte, err error) {
	file, info, err := claudefiles.Open(projects, path, want)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
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

func oneLine(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= sessionTextMax {
		return text
	}
	return string([]rune(text)[:sessionTextMax-1]) + "…"
}
