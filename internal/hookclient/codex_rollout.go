package hookclient

// A `codex exec` run that prints text tells its tools and what it writes in
// its rollout: codex writes each item of the session as it completes to
// <codex home>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl, a
// line each. Once the run's header tells its session, exec-run follows that
// file beside the run, as print-run follows a `claude -p` run's transcript
// (print_transcript.go); a run that goes on a session, from where it was.
//
// An item is written once it completed, so each tool is told as it ends,
// with how long it took.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// codexRollout follows a run's rollout.
type codexRollout struct {
	// sessions is codex's directory of sessions, by day.
	sessions string
	// ids gets the run's session id, once it is known.
	ids chan string
	// id is the session id, once the follower got it.
	id string
	// from is where in it the run's part starts: its end before the run,
	// for a run that goes on a session.
	from       int64
	stop, done chan struct{}
}

// newCodexRollout is the rollout of a run whose session is told later
// (know); nil when codex's directory is not known.
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

// know tells the rollout the run's session id; the first one told counts.
func (r *codexRollout) know(id string) {
	select {
	case r.ids <- id:
	default:
	}
}

// startAtEnd has the session's rollout followed from where it is now: a
// run that goes on a session adds to its rollout. Called before follow.
func (r *codexRollout) startAtEnd(id string) {
	if path := r.path(id); path != "" {
		if info, err := os.Stat(path); err == nil {
			r.from = info.Size()
		}
	}
	r.know(id)
}

// path is where the session's rollout is; empty when it is not there yet.
func (r *codexRollout) path(id string) string {
	matches, _ := filepath.Glob(filepath.Join(r.sessions, "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[len(matches)-1]
}

// open opens the rollout, once the session is known and codex made it.
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

// follow hands each line written to the rollout to `line` as it comes, once
// it is found, which it tells `found` of, until the run's end.
func (r *codexRollout) follow(line func([]byte), found func()) {
	followFile(r.open, r.from, line, found, r.stop, r.done)
}

// end reads the rest of the rollout once the run is over, and waits up to
// `wait` for it: false when it did not finish.
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

// rolloutLine is a line of a rollout, cut to what is read: an item that
// completed, and when it started and ended.
type rolloutLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type          string          `json:"type"`
		Item          json.RawMessage `json:"item"`
		StartedAtMs   int64           `json:"started_at_ms"`
		CompletedAtMs int64           `json:"completed_at_ms"`
	} `json:"payload"`
}

// rolloutItem is an item as a rollout writes it, as codex 0.166 does.
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

// rolloutLine reads a line of the run's rollout: an item that completed is
// told as `codex exec --json` tells it, a tool with how long it took.
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

// eventItemOf is a rollout's item as `codex exec --json` prints it; false
// for one it does not tell, as the user's message or reasoning.
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

// argvCommand is a command a rollout gives as its arguments, as
// `codex exec --json` prints it: the shell's script, else the words.
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
