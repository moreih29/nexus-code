package hookclient

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

func wrapperHookSubcommands(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile("../../scripts/assets/claude-wrapper.sh")
	if err != nil {
		t.Fatal(err)
	}
	var subcommands []string
	for _, m := range regexp.MustCompile(`\\"\$\{NEXUS_AGENT_BIN\}\\" hook ([a-z-]+)"`).FindAllSubmatch(data, -1) {
		subcommands = append(subcommands, string(m[1]))
	}
	if len(subcommands) < 12 {
		t.Fatalf("found only %v in the wrapper's hooks", subcommands)
	}
	return subcommands
}

func TestEveryWrapperHookWithoutTheServer(t *testing.T) {
	for _, subcommand := range wrapperHookSubcommands(t) {
		t.Run(subcommand, func(t *testing.T) {
			clearHookEnv(t)
			payload, _ := json.Marshal(map[string]any{
				"hook_event_name": subcommand,
				"tool_name":       "SendMessage",
				"tool_input":      map[string]any{"to": "bridge:session_x", "command": "echo hi"},
			})
			withStdin(t, payload)
			stdout := captureStdout(t)
			code := Run([]string{subcommand})
			out := stdout()
			if code != 0 {
				t.Fatalf("exit %d, want 0", code)
			}
			if subcommand == sendMessageSubcmd {
				var got preToolUseOutput
				if err := json.Unmarshal([]byte(out), &got); err != nil || got.HookSpecificOutput.PermissionDecision != "deny" {
					t.Fatalf("stdout %q, want the SendMessage deny without the server", out)
				}
				return
			}
			if out != "" {
				t.Fatalf("stdout %q, want nothing: no decision, so Claude Code keeps its own flow", out)
			}
		})
	}
}
