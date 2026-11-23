package hookclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type codexRollout struct {
	sessions   string
	ids        chan string
	id         string
	from       int64
	stop, done chan struct{}
}

func newCodexRollout() *codexRollout {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		dir = filepath.Join(home, ".codex")
	}
	return &codexRollout{
		sessions: filepath.Join(dir, "sessions"),
		ids:      make(chan string, 1),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

func (r *codexRollout) know(id string) {
	select {
	case r.ids <- id:
	default:
	}
}

func (r *codexRollout) startAtEnd(id string) {
	if path := r.path(id); path != "" {
		if info, err := os.Stat(path); err == nil {
			r.from = info.Size()
		}
	}
	r.know(id)
}

func (r *codexRollout) path(id string) string {
	matches, _ := filepath.Glob(filepath.Join(r.sessions, "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[len(matches)-1]
}

func (r *codexRollout) open() *os.File {
	if r.id == "" {
		select {
		case r.id = <-r.ids:
		default:
			return nil
		}
	}
	path := r.path(r.id)
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	return file
}

func (r *codexRollout) follow(line func([]byte), found func()) {
	followFile(r.open, r.from, line, found, r.stop, r.done)
}

func (r *codexRollout) end(wait time.Duration) bool {
	close(r.stop)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-r.done:
		return true
	case <-timer.C:
		return false
	}
}

type rolloutLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type          string          `json:"type"`
		Item          json.RawMessage `json:"item"`
		StartedAtMs   int64           `json:"started_at_ms"`
		CompletedAtMs int64           `json:"completed_at_ms"`
	} `json:"payload"`
}

type rolloutItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Command          []string `json:"command"`
	AggregatedOutput string   `json:"aggregated_output"`
	ExitCode         *int     `json:"exit_code"`
	Status           string   `json:"status"`
	Changes          map[string]struct {
		Type string `json:"type"`
	} `json:"changes"`
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Query     string          `json:"query"`
	Error     *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (w *codexWatch) rolloutLine(b []byte) {
	var line rolloutLine
	if json.Unmarshal(b, &line) != nil ||
		line.Type != "event_msg" || line.Payload.Type != "item_completed" {
		return
	}
	var raw rolloutItem
	if json.Unmarshal(line.Payload.Item, &raw) != nil {
		return
	}
	item, ok := eventItemOf(raw)
	if !ok {
		return
	}
	var took int64
	if p := line.Payload; p.StartedAtMs > 0 && p.CompletedAtMs > p.StartedAtMs {
		took = p.CompletedAtMs - p.StartedAtMs
	}
	w.completed(item, took)
}

func eventItemOf(raw rolloutItem) (codexItem, bool) {
	item := codexItem{ID: raw.ID, Status: raw.Status}
	switch raw.Type {
	case "AgentMessage":
		texts := make([]string, 0, len(raw.Content))
		for _, part := range raw.Content {
			if strings.EqualFold(part.Type, "text") {
				texts = append(texts, part.Text)
			}
		}
		item.Type = "agent_message"
		item.Text = strings.Join(texts, "\n")
	case "CommandExecution":
		item.Type = "command_execution"
		item.Command = argvCommand(raw.Command)
		item.AggregatedOutput = raw.AggregatedOutput
		item.ExitCode = raw.ExitCode
	case "FileChange":
		item.Type = "file_change"
		paths := make([]string, 0, len(raw.Changes))
		for path := range raw.Changes {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			item.Changes = append(item.Changes, struct {
				Path string `json:"path"`
				Kind string `json:"kind"`
			}{path, raw.Changes[path].Type})
		}
	case "McpToolCall":
		item.Type = "mcp_tool_call"
		item.Server, item.Tool, item.Arguments, item.Error = raw.Server, raw.Tool, raw.Arguments, raw.Error
	case "WebSearch":
		item.Type = "web_search"
		item.Query = raw.Query
	default:
		return codexItem{}, false
	}
	return item, true
}

func argvCommand(argv []string) string {
	if len(argv) == 3 && (argv[1] == "-lc" || argv[1] == "-c") {
		switch strings.TrimSuffix(strings.ToLower(filepath.Base(argv[0])), ".exe") {
		case "bash", "zsh", "sh":
			return argv[2]
		}
	}
	for i, arg := range argv {
		if strings.EqualFold(arg, "-Command") && i+1 < len(argv) {
			return strings.Join(argv[i+1:], " ")
		}
	}
	return strings.Join(argv, " ")
}
