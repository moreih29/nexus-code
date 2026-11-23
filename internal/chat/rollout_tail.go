package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	rolloutTailTurns     = 3
	rolloutTailMaxTurns  = 10
	rolloutTailScanBytes = 8 << 20
	rolloutTailText      = 8 << 10
	rolloutTailEvents    = 5000
	rolloutTailBytes     = 512 << 10
	rolloutTailForks     = 4
)

func (s *Service) RolloutTail(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RolloutTailParams
	if err := proto.DecodeParams(raw, &p, "chat.rolloutTail params must include threadId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.ThreadID) {
		return nil, proto.ProtocolError("chat.rolloutTail threadId is not a thread id")
	}
	turns := p.Turns
	if turns <= 0 {
		turns = rolloutTailTurns
	}
	home := codexHome(p.CodexHome)
	path := ""
	if home != "" {
		path = keptRollout(home, p.ThreadID)
	}
	if path == "" {
		return RolloutTailResult{Found: false, Events: []RolloutEvent{}}, nil
	}
	tail := rolloutTail{ctx: ctx, want: min(turns, rolloutTailMaxTurns), budget: rolloutTailScanBytes}
	end := int64(0)
	for fork := 0; ; fork++ {
		parent, parentEnd, err := tail.read(path, end)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, proto.RequestFailed("chat.rolloutTail: %s", err)
		}
		if tail.done || parent == "" {
			break
		}
		if !tail.full && fork+1 < rolloutTailForks {
			if parentPath := keptRollout(home, parent); parentPath != "" {
				path, end = parentPath, parentEnd
				continue
			}
		}
		tail.more = true
		break
	}
	events := tail.events
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	events, cut := fitRolloutEvents(events, rolloutTailBytes)
	return RolloutTailResult{Found: true, Events: events, More: tail.more || cut}, nil
}

func fitRolloutEvents(events []RolloutEvent, limit int) ([]RolloutEvent, bool) {
	sizes := make([]int, len(events))
	total := 0
	for i, event := range events {
		encoded, _ := json.Marshal(event)
		sizes[i] = len(encoded) + 1
		total += sizes[i]
	}
	start := 0
	for total > limit && start < len(events) {
		next := start + 1
		for next < len(events) && events[next].Kind != "user" {
			next++
		}
		if next >= len(events) {
			next = start + 1
		}
		for ; start < next; start++ {
			total -= sizes[start]
		}
	}
	return events[start:], start > 0
}

type rolloutTail struct {
	ctx       context.Context
	want      int
	budget    int64
	events    []RolloutEvent
	users     int
	full      bool
	turnTaken bool
	replied   bool
	done      bool
	more      bool
}

func (t *rolloutTail) read(path string, end int64) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if end <= 0 || end > info.Size() {
		end = info.Size()
	}
	floor := max(0, end-t.budget)
	reader := transcriptReverseReader{ctx: t.ctx, file: file, floor: floor}
	pos := end
	defer func() { t.budget -= end - pos }()
	for pos > floor {
		start, lineEnd, err := reader.previous(pos)
		if err != nil {
			return "", 0, err
		}
		if start == floor && floor != 0 {
			pos = floor
			break
		}
		line, err := reader.read(start, lineEnd)
		if err != nil {
			return "", 0, err
		}
		pos = start
		if start == 0 {
			return t.first(line)
		}
		if t.take(line) {
			t.done = true
			return "", 0, nil
		}
	}
	if pos > 0 {
		t.more, t.done = true, true
	}
	return "", 0, nil
}

func (t *rolloutTail) first(line []byte) (string, int64, error) {
	var meta struct {
		Type    string `json:"type"`
		Payload struct {
			ForkedFromID string `json:"forked_from_id"`
			HistoryBase  struct {
				EndByteOffset int64 `json:"end_byte_offset"`
			} `json:"history_base"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &meta) != nil || meta.Type != "session_meta" {
		if t.take(line) {
			t.done = true
		}
		return "", 0, nil
	}
	parent, parentEnd := meta.Payload.ForkedFromID, meta.Payload.HistoryBase.EndByteOffset
	if !sessionIDPattern.MatchString(parent) || parentEnd <= 0 {
		return "", 0, nil
	}
	if t.full {
		t.more, t.done = true, true
		return "", 0, nil
	}
	return parent, parentEnd, nil
}

func (t *rolloutTail) take(line []byte) bool {
	if !bytes.Contains(line, []byte(`"event_msg"`)) {
		return false
	}
	event, ok := rolloutEventOf(line)
	if !ok {
		return false
	}
	if t.full {
		if event.Kind == "turn" && !t.turnTaken {
			t.turnTaken = true
			t.events = append(t.events, event)
			return false
		}
		if event.Kind == "turn" {
			return false
		}
		t.more = true
		return true
	}
	if len(t.events) >= rolloutTailEvents {
		t.more = true
		return true
	}
	switch event.Kind {
	case "agent":
		if t.replied || strings.TrimSpace(event.Text) == "" {
			return false
		}
		t.replied = true
	case "user":
		t.replied = false
		t.users++
		t.full = t.users >= t.want
	}
	t.events = append(t.events, event)
	return false
}

type rolloutRecord struct {
	Type    string `json:"type"`
	Payload struct {
		Type        string            `json:"type"`
		TurnID      string            `json:"turn_id"`
		Message     string            `json:"message"`
		Images      []json.RawMessage `json:"images"`
		LocalImages []json.RawMessage `json:"local_images"`
		Invocation  struct {
			Server string `json:"server"`
			Tool   string `json:"tool"`
		} `json:"invocation"`
		Changes map[string]struct {
			Type string `json:"type"`
		} `json:"changes"`
		Item *struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			ClientID string `json:"client_id"`
			Changes  map[string]struct {
				Type string `json:"type"`
			} `json:"changes"`
			Server string `json:"server"`
			Tool   string `json:"tool"`
			Kind   string `json:"kind"`
		} `json:"item"`
	} `json:"payload"`
}

func rolloutEventOf(line []byte) (RolloutEvent, bool) {
	var record rolloutRecord
	if json.Unmarshal(line, &record) != nil || record.Type != "event_msg" {
		return RolloutEvent{}, false
	}
	p := record.Payload
	event := RolloutEvent{TurnID: p.TurnID}
	tool := func(kind string) (RolloutEvent, bool) {
		event.Kind, event.Tool = "tool", kind
		return event, true
	}
	switch p.Type {
	case "task_started":
		event.Kind = "turn"
		return event, p.TurnID != ""
	case "user_message":
		event.Kind, event.Text = "user", cutText(p.Message)
		event.Images = len(p.Images) + len(p.LocalImages)
		return event, true
	case "agent_message":
		event.Kind, event.Text = "agent", cutText(p.Message)
		return event, true
	case "exec_command_end":
		return tool("commandExecution")
	case "patch_apply_end":
		event.Changes = changeKinds(p.Changes)
		return tool("fileChange")
	case "web_search_end":
		return tool("webSearch")
	case "view_image_tool_call":
		return tool("imageView")
	case "mcp_tool_call_end":
		event.Server, event.Name = p.Invocation.Server, p.Invocation.Tool
		return tool("mcpToolCall")
	case "item_completed":
	default:
		return RolloutEvent{}, false
	}
	item := p.Item
	if item == nil {
		return RolloutEvent{}, false
	}
	switch item.Type {
	case "UserMessage":
		texts := make([]string, 0, len(item.Content))
		for _, part := range item.Content {
			if strings.EqualFold(part.Type, "text") {
				texts = append(texts, part.Text)
			} else if strings.Contains(strings.ToLower(part.Type), "image") {
				event.Images++
			}
		}
		event.Kind, event.Text, event.ClientID = "user", cutText(strings.Join(texts, "\n")), item.ClientID
		return event, true
	case "AgentMessage":
		texts := make([]string, 0, len(item.Content))
		for _, part := range item.Content {
			if strings.EqualFold(part.Type, "text") {
				texts = append(texts, part.Text)
			}
		}
		event.Kind, event.Text = "agent", cutText(strings.Join(texts, "\n"))
		return event, true
	case "CommandExecution":
		return tool("commandExecution")
	case "FileChange":
		event.Changes = changeKinds(item.Changes)
		return tool("fileChange")
	case "McpToolCall":
		event.Server, event.Name = item.Server, item.Tool
		return tool("mcpToolCall")
	case "WebSearch":
		return tool("webSearch")
	case "ImageView":
		return tool("imageView")
	case "DynamicToolCall":
		event.Name = item.Tool
		return tool("dynamicToolCall")
	case "CollabAgentToolCall":
		event.Name = item.Tool
		return tool("collabAgentToolCall")
	case "Extension":
		if item.Kind == "web.search" {
			return tool("webSearch")
		}
	}
	return RolloutEvent{}, false
}

func changeKinds(changes map[string]struct {
	Type string `json:"type"`
}) []string {
	paths := make([]string, 0, len(changes))
	for path := range changes {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	kinds := make([]string, 0, len(paths))
	for _, path := range paths {
		kinds = append(kinds, changes[path].Type)
	}
	return kinds
}

func cutText(text string) string {
	if len(text) <= rolloutTailText {
		return text
	}
	end := rolloutTailText
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}
