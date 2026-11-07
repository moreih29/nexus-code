package hookclient

// What a subagent wrote between its tools: a hook of a subagent's call
// (agent_id set) tells its tools but not its text, so the client reads the
// subagent's transcript, which Claude Code writes beside its session's, and
// sends the latest of its text blocks with the hook. Main keeps those it did
// not have yet, as of when it got them.
//
// The transcript is on the host the hook runs on, as the session's is (see
// transcript.go), so a remote workspace's needs no routing in main.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// agentMessagesKept is how many of a subagent's latest messages a hook
// sends, as many as main keeps (AGENT_MESSAGES_KEPT).
const agentMessagesKept = 20

// agentTranscriptTail is how much of a subagent's transcript is read, from
// its end: its latest messages are there.
const agentTranscriptTail int64 = 1024 * 1024

// agentMessageSubcmds are the hooks of a subagent's call at which what it
// wrote so far is read.
var agentMessageSubcmds = map[string]bool{
	"pre-tool-use":          true,
	"post-tool-use":         true,
	"post-tool-use-failure": true,
	"subagent-stop":         true,
}

// agentMessage is a text block a subagent wrote; its id names it among the
// subagent's, so main keeps each once.
type agentMessage struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// agentPayload is what a subagent's hook tells of where its transcript is.
type agentPayload struct {
	AgentID             string `json:"agent_id"`
	TranscriptPath      string `json:"transcript_path"`
	AgentTranscriptPath string `json:"agent_transcript_path"`
}

// hookAgentMessages is what the subagent of a hook's call wrote so far: none
// for a hook of the session's own call, or of another subcommand.
func hookAgentMessages(subcommand string, payload json.RawMessage) []agentMessage {
	if !agentMessageSubcmds[subcommand] || len(payload) == 0 {
		return nil
	}
	var p agentPayload
	if json.Unmarshal(payload, &p) != nil {
		return nil
	}
	path := agentTranscriptPath(p)
	if path == "" {
		return nil
	}
	return readAgentMessages(path)
}

// agentTranscriptPath is where the subagent's transcript is: as its hook
// tells it, else beside its session's, as Claude Code keeps it at
// <session transcript without .jsonl>/subagents/agent-<agent id>.jsonl.
func agentTranscriptPath(p agentPayload) string {
	if p.AgentID == "" || strings.ContainsAny(p.AgentID, `/\`) || strings.Contains(p.AgentID, "..") {
		return ""
	}
	if p.AgentTranscriptPath != "" {
		return p.AgentTranscriptPath
	}
	session, ok := strings.CutSuffix(p.TranscriptPath, ".jsonl")
	if !ok || session == "" {
		return ""
	}
	return filepath.Join(session, "subagents", "agent-"+p.AgentID+".jsonl")
}

// agentTranscriptLine is a line of a subagent's transcript, cut to what is
// read: an assistant message's blocks, and the line's id.
type agentTranscriptLine struct {
	UUID    string `json:"uuid"`
	Message struct {
		Role    string          `json:"role"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// readAgentMessages is the latest text blocks of a subagent's transcript,
// oldest first; none when it cannot be read.
func readAgentMessages(path string) []agentMessage {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	reader := bufio.NewReader(file)
	if from := info.Size() - agentTranscriptTail; from > 0 {
		if _, err := file.Seek(from, io.SeekStart); err != nil {
			return nil
		}
		reader.Reset(file)
		// The line cut at the tail's start is not read.
		if _, err := reader.ReadBytes('\n'); err != nil {
			return nil
		}
	}
	var messages []agentMessage
	for {
		b, err := reader.ReadBytes('\n')
		if len(b) > 0 && err == nil {
			messages = append(messages, agentMessagesOf(b)...)
			if len(messages) > agentMessagesKept {
				messages = messages[len(messages)-agentMessagesKept:]
			}
		}
		// A line not ended yet is still being written: it is read next time.
		if err != nil {
			break
		}
	}
	return messages
}

// agentMessagesOf is a transcript line's text blocks, when it is an
// assistant message (not one Claude Code makes up, as "<synthetic>").
func agentMessagesOf(b []byte) []agentMessage {
	var line agentTranscriptLine
	if json.Unmarshal(b, &line) != nil || line.UUID == "" ||
		line.Message.Role != "assistant" || strings.HasPrefix(line.Message.Model, "<") {
		return nil
	}
	var messages []agentMessage
	for i, block := range blocksOf(line.Message.Content) {
		if block.Type != "text" {
			continue
		}
		if said := strings.TrimSpace(block.Text); said != "" {
			messages = append(messages, agentMessage{
				ID:   line.UUID + ":" + strconv.Itoa(i),
				Text: cut(said, printTextMax),
			})
		}
	}
	return messages
}
