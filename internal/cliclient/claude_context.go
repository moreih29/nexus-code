package cliclient

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const claudeHookContextLimit = 10_000

type claudeHookOutput struct {
	Context struct {
		Event string `json:"hookEventName"`
		Text  string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

func claudeHookContext(input, stdout string) (string, error) {
	if len(stdout) <= claudeHookContextLimit {
		return stdout, nil
	}
	var hook struct {
		Event      string `json:"hook_event_name"`
		Transcript string `json:"transcript_path"`
	}
	if json.Unmarshal([]byte(input), &hook) != nil ||
		(hook.Event != "SessionStart" && hook.Event != "UserPromptSubmit") {
		return stdout, nil
	}
	var reply claudeHookOutput
	text := strings.TrimSuffix(stdout, "\n")
	if json.Unmarshal([]byte(stdout), &reply) == nil && reply.Context.Event == hook.Event {
		text = reply.Context.Text
	} else if hook.Event != "SessionStart" {
		return stdout, nil
	}
	units := 0
	for _, char := range text {
		units++
		if char > 0xffff {
			units++
		}
	}
	if units <= claudeHookContextLimit {
		return stdout, nil
	}
	session, ok := strings.CutSuffix(hook.Transcript, ".jsonl")
	if !ok || !filepath.IsAbs(session) {
		return stdout, fmt.Errorf("missing Claude session transcript path")
	}
	file, err := writeClaudeHookContext(filepath.Join(session, "tool-results"), text)
	if err != nil {
		return stdout, err
	}
	reply.Context.Event = hook.Event
	reply.Context.Text = fmt.Sprintf(
		"Read the entire NexusCode instructions file at %q, in sections if needed, before responding or using other tools. Follow it in place of any earlier NexusCode instructions.",
		filepath.ToSlash(file),
	)
	data, err := json.Marshal(reply)
	return string(data) + "\n", err
}

func writeClaudeHookContext(dir, text string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, "nexus-instructions-*.txt")
	if err != nil {
		return "", err
	}
	_, writeErr := file.WriteString(text)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(file.Name())
		if writeErr != nil {
			return "", writeErr
		}
		return "", closeErr
	}
	return file.Name(), nil
}
