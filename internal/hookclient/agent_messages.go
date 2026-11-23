package hookclient

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const agentMessagesKept = 20

const agentTranscriptTail int64 = 1024 * 1024

var agentMessageSubcmds = map[string]bool{
	"pre-tool-use":          true,
	"post-tool-use":         true,
	"post-tool-use-failure": true,
	"subagent-stop":         true,
}

type agentMessage struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type agentPayload struct {
	AgentID             string `json:"agent_id"`
	TranscriptPath      string `json:"transcript_path"`
	AgentTranscriptPath string `json:"agent_transcript_path"`
}

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

type agentTranscriptLine struct {
	UUID    string `json:"uuid"`
	Message struct {
		Role    string          `json:"role"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

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
		if err != nil {
			break
		}
	}
	return messages
}

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
