package hookclient

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDescribeCodexExec(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want codexRun
	}{
		{
			"codex's options before exec, its own after, then the prompt",
			[]string{"--no-daemon", "-m", "o3", "-c", `model_provider="gw"`, "exec", "--skip-git-repo-check", "--json", "-C", "/w", "fix it"},
			codexRun{exec: true, prompt: "fix it", model: "o3", provider: "gw", events: true},
		},
		{
			"options with =, a model set in config, a profile",
			[]string{"exec", "--config=model='gpt-6'", "--profile=fast", "--experimental-json", "go"},
			codexRun{exec: true, prompt: "go", model: "gpt-6", profile: "fast", events: true},
		},
		{
			"the prompt read from stdin, by - or none",
			[]string{"e", "-o", "/tmp/last.txt", "--ephemeral", "-"},
			codexRun{exec: true, stdinPrompt: true, ephemeral: true},
		},
		{
			"a session resumed by its id",
			[]string{"exec", "resume", sessionA, "go on"},
			codexRun{exec: true, prompt: "go on", sessionID: sessionA, resumed: true},
		},
		{
			"the latest session resumed, or one by its name",
			[]string{"exec", "resume", "--last", "go on"},
			codexRun{exec: true, prompt: "go on", resumed: true},
		},
		{
			"a session named rather than its id",
			[]string{"exec", "resume", "my-thread"},
			codexRun{exec: true, stdinPrompt: true, resumed: true},
		},
		{
			"a review",
			[]string{"exec", "review", "--uncommitted"},
			codexRun{exec: true, prompt: "review"},
		},
		{
			"an open-source provider, and no user config",
			[]string{"--oss", "--local-provider", "ollama", "exec", "--ignore-user-config", "hi"},
			codexRun{exec: true, prompt: "hi", provider: "ollama", noConfig: true},
		},
	}
	for _, tc := range cases {
		if got := describeCodexExec(tc.args); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
	for _, args := range [][]string{
		{"exec", "--help"},
		{"exec", "help"},
		{"--version"},
		{"resume", "--last"},
		{"-m", "exec", "hi"},
		{"--", "exec"},
		{},
	} {
		if got := describeCodexExec(args); got.exec {
			t.Errorf("%q runs no codex exec, read as %+v", args, got)
		}
	}
}

func TestTomlString(t *testing.T) {
	for value, want := range map[string]string{
		` "gpt-6" # cheap`:     "gpt-6",
		`"a \"quoted\" name"`:  `a "quoted" name`,
		`'C:\path'`:            `C:\path`,
		` bare # comment`:      "bare",
		``:                     "",
		`"unterminated`:        "unterminated",
		`"https://gw.x/v1"  `:  "https://gw.x/v1",
		`"tab\there" # and so`: "tab\there",
	} {
		if got := tomlString(value); got != want {
			t.Errorf("tomlString(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestCodexRun_SettlesItsModelAndWhereItIsServed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("OPENAI_BASE_URL", "")
	config := `# codex
model = "gpt-6-luna" # cheap
model_provider = "gw"

[model_providers.gw]
name = "Gateway"
base_url = "https://user:secret@gw.example.com:8443/v1"

[model_providers."local"]
base_url = "http://127.0.0.1:11434/v1"
`
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("config.toml", config)
	write("fast.config.toml", "model = \"fast-model\"\n")

	run := codexRun{exec: true}
	if endpoint := run.settle(); endpoint != "gw.example.com:8443" || run.model != "gpt-6-luna" || run.provider != "gw" {
		t.Fatalf("settled %q, %+v", endpoint, run)
	}
	run = codexRun{exec: true, profile: "fast", model: "", provider: "local"}
	if endpoint := run.settle(); endpoint != "127.0.0.1:11434" || run.model != "fast-model" {
		t.Fatalf("settled %q, %+v", endpoint, run)
	}
	run = codexRun{exec: true, model: "o3", provider: "openai"}
	if endpoint := run.settle(); endpoint != "" || run.model != "o3" {
		t.Fatalf("settled %q, %+v", endpoint, run)
	}
	t.Setenv("OPENAI_BASE_URL", "https://proxy.internal/v1")
	run = codexRun{exec: true, provider: "openai"}
	if endpoint := run.settle(); endpoint != "proxy.internal" {
		t.Fatalf("settled %q", endpoint)
	}
	run = codexRun{exec: true, provider: "ollama", noConfig: true}
	if endpoint := run.settle(); endpoint != "ollama" || run.model != "" {
		t.Fatalf("settled %q, %+v", endpoint, run)
	}
}

func TestEndpointHost(t *testing.T) {
	for _, tc := range []struct{ base, home, want string }{
		{"https://gw.example.com/v1", "api.anthropic.com", "gw.example.com"},
		{"https://API.anthropic.com", "api.anthropic.com", ""},
		{"http://u:p@10.0.0.2:4000/anthropic?key=x", "api.anthropic.com", "10.0.0.2:4000"},
		{"gw.local:8080", "", "gw.local:8080"},
		{"  ", "", ""},
	} {
		if got := endpointHost(tc.base, tc.home); got != tc.want {
			t.Errorf("endpointHost(%q) = %q, want %q", tc.base, got, tc.want)
		}
	}
}

// codexEvents is a `codex exec --json` run's output, as codex 0.166 prints it.
var codexEvents = []string{
	`{"type":"thread.started","thread_id":"01a1b19e-c0ae-72c0-b93e-b6494ea7a613"}`,
	`{"type":"turn.started"}`,
	`{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/bash -lc 'npm test'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
	`{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/bash -lc 'npm test'","aggregated_output":"> test\nFAIL src/a.test.ts\n","exit_code":1,"status":"failed"}}`,
	`{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking"}}`,
	`{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/w/src/a.ts","kind":"update"},{"path":"/w/src/b.ts","kind":"add"}],"status":"completed"}}`,
	`{"type":"item.started","item":{"id":"item_3","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"router"},"status":"in_progress"}}`,
	`{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"router"},"status":"failed","error":{"message":"server gone"}}}`,
	`{"type":"item.completed","item":{"id":"item_4","type":"web_search","query":"codex exec json"}}`,
	`{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"Fixed the test."}}`,
	`{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}`,
}

func TestCodexWatch_TellsTheRunsToolsAndAnswer(t *testing.T) {
	var told []toldFrame
	watch := &codexWatch{prefix: "r:", tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}}
	for _, line := range codexEvents {
		watch.line([]byte(line))
	}
	watch.line([]byte("not json"))
	use := func(id, name string, input map[string]any) toldFrame {
		return toldFrame{"print-tool-use", map[string]any{"tool_use_id": id, "tool_name": name, "tool_input": input}}
	}
	result := func(id string, failed bool, why string) toldFrame {
		payload := map[string]any{"tool_use_id": id, "is_error": failed}
		if why != "" {
			payload["error"] = why
		}
		return toldFrame{"print-tool-result", payload}
	}
	want := []toldFrame{
		{"print-init", map[string]any{"session_id": "01a1b19e-c0ae-72c0-b93e-b6494ea7a613"}},
		use("r:item_0", "Bash", map[string]any{"command": "npm test"}),
		result("r:item_0", true, "FAIL src/a.test.ts"),
		use("r:item_2:0", "Edit", map[string]any{"file_path": "/w/src/a.ts"}),
		result("r:item_2:0", false, ""),
		use("r:item_2:1", "Write", map[string]any{"file_path": "/w/src/b.ts"}),
		result("r:item_2:1", false, ""),
		use("r:item_3", "mcp__docs__search", map[string]any{"q": "router"}),
		result("r:item_3", true, "server gone"),
		use("r:item_4", "WebSearch", map[string]any{"query": "codex exec json"}),
		result("r:item_4", false, ""),
		{"print-text", map[string]any{"text": "Fixed the test."}},
	}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("told:\n%v\nwant:\n%v", told, want)
	}
	if watch.result() != "Fixed the test." {
		t.Fatalf("answer %q", watch.result())
	}
}

func TestCodexWatch_TellsNoSessionNotKept(t *testing.T) {
	var told []toldFrame
	watch := &codexWatch{noSession: true, tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}}
	watch.line([]byte(codexEvents[0]))
	if len(told) != 0 {
		t.Fatalf("told %v", told)
	}
}

func TestCodexWatch_AnswersWhyATurnFailed(t *testing.T) {
	watch := &codexWatch{tell: func(string, map[string]any) {}}
	watch.line([]byte(`{"type":"turn.failed","error":{"message":"stream disconnected"}}`))
	if watch.result() != "stream disconnected" {
		t.Fatalf("answer %q", watch.result())
	}
	text := &codexWatch{text: true}
	text.line([]byte("Done."))
	text.line([]byte("All tests pass."))
	if text.result() != "Done.\nAll tests pass." {
		t.Fatalf("answer %q", text.result())
	}
}

func TestCodexHeader_TellsTheModelAndSession(t *testing.T) {
	var told []toldFrame
	run := codexRun{provider: "gw", baseURLs: map[string]string{"corp": "https://llm.corp/v1"}}
	var sessions []string
	header := &codexHeader{run: &run, tell: func(subcommand string, payload map[string]any) {
		told = append(told, toldFrame{subcommand, payload})
	}, session: func(id string) {
		// Once the header was told.
		if len(told) == 1 {
			sessions = append(sessions, id)
		}
	}}
	for _, line := range []string{
		"Reading additional input from stdin...",
		"OpenAI Codex v0.166.0",
		"--------",
		"workdir: /tmp/cx",
		"model: gpt-6-luna",
		"provider: corp",
		"session id: 01a1b19e-e57a-74f2-af0e-e1be5b21d5ac",
		"--------",
		"user",
		"model: not the header",
		"--------",
	} {
		header.line([]byte(line))
	}
	want := []toldFrame{{"print-init", map[string]any{
		"model":      "gpt-6-luna",
		"endpoint":   "llm.corp",
		"session_id": "01a1b19e-e57a-74f2-af0e-e1be5b21d5ac",
	}}}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("told %v", told)
	}
	if !reflect.DeepEqual(sessions, []string{"01a1b19e-e57a-74f2-af0e-e1be5b21d5ac"}) {
		t.Fatalf("sessions %v", sessions)
	}
}

func TestShownCommand(t *testing.T) {
	for command, want := range map[string]string{
		`/bin/bash -lc 'echo hi'`:                     "echo hi",
		`bash -c "git status"`:                        "git status",
		`/bin/zsh -lc 'it'\''s'`:                      "it's",
		`"C:\WINDOWS\powershell.exe" -Command 'dir'`:  "dir",
		`/bin/bash -lc echo $HOME`:                    `/bin/bash -lc echo $HOME`,
		`rg -n foo`:                                   "rg -n foo",
		`/bin/bash -lc 'unterminated`:                 `/bin/bash -lc 'unterminated`,
		`/bin/bash -lc "say \"hi\""`:                  `say "hi"`,
		`/bin/bash -lc "echo $(whoami)"`:              `/bin/bash -lc "echo $(whoami)"`,
		`/bin/bash -lc 'cd /w && npm test -- --ci'`:   "cd /w && npm test -- --ci",
		"/bin/bash -lc 'cat <<EOF\nline\nEOF'":        "cat <<EOF\nline\nEOF",
		`/usr/bin/sh -c 'printf "%s\n" "a b"'`:        `printf "%s\n" "a b"`,
		`/bin/bash -lc 'ls'  `:                        `/bin/bash -lc 'ls'  `,
		`/bin/bash -lc 'grep -rn "TODO" src/ | head'`: `grep -rn "TODO" src/ | head`,
	} {
		if got := shownCommand(command); got != want {
			t.Errorf("shownCommand(%q) = %q, want %q", command, got, want)
		}
	}
}
