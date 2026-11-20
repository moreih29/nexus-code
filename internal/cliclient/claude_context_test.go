package cliclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestClaudeHookContextKeepsFullInstructions(t *testing.T) {
	for _, event := range []string{"SessionStart", "UserPromptSubmit"} {
		t.Run(event, func(t *testing.T) {
			session := filepath.Join(t.TempDir(), "session")
			input, _ := json.Marshal(map[string]string{
				"hook_event_name": event, "transcript_path": session + ".jsonl",
			})
			const tail = "\nlast instruction"
			atLimit := strings.Repeat("한", 10_000-len(tail)) + tail
			long := strings.Repeat("🧪", 5000) + tail
			format := func(text string) string {
				if event == "SessionStart" {
					return text + "\n"
				}
				var reply claudeHookOutput
				reply.Context.Event = event
				reply.Context.Text = text
				data, _ := json.Marshal(reply)
				return string(data) + "\n"
			}
			short := format(atLimit)
			if got, err := claudeHookContext(string(input), short); err != nil || got != short {
				t.Fatalf("context at the UTF-16 limit changed: %v", err)
			}
			got, err := claudeHookContext(string(input), format(long))
			if err != nil {
				t.Fatal(err)
			}
			var reply claudeHookOutput
			if err := json.Unmarshal([]byte(got), &reply); err != nil || reply.Context.Event != event {
				t.Fatalf("invalid hook output: %v", err)
			}
			files, err := filepath.Glob(filepath.Join(session, "tool-results", "nexus-instructions-*.txt"))
			if err != nil || len(files) != 1 {
				t.Fatalf("files = %v, %v", files, err)
			}
			if !strings.Contains(reply.Context.Text, filepath.ToSlash(files[0])) || len(got) > 1000 {
				t.Fatalf("hook output should point to the full instructions")
			}
			data, err := os.ReadFile(files[0])
			if err != nil || string(data) != long {
				t.Fatalf("saved instructions differ: %v", err)
			}
			if runtime.GOOS != "windows" {
				info, err := os.Stat(files[0])
				if err != nil || info.Mode().Perm()&0o077 != 0 {
					t.Fatalf("instructions file is not private: %v", err)
				}
			}
		})
	}
}
