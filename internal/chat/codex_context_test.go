package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

const notesThread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const notesFork = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func TestCodexContextAugmentsOnlyTurnStart(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	context := codexContext{Files: "File links", CLI: &codexCLIContext{Status: "CLI guidance", Commands: "Commands"}}
	start := `{"method":"turn/start","id":"turn","params":{"threadId":"` + notesThread +
		`","input":[{"type":"text","text":"Hello"}],"additionalContext":{"other":{"kind":"untrusted","value":"other context"}}}}`
	fragments := testCodexContext(t, proc.withCodexContext([]byte(start), context))
	if len(fragments) != 4 || fragments["other"].Value != "other context" ||
		fragments[codexFileLinks].Kind != "application" || fragments[codexCLI].Kind != "application" {
		t.Fatalf("unexpected fragments: %#v", fragments)
	}
	for _, method := range []string{"thread/start", "thread/resume", "thread/fork", "turn/steer"} {
		request := `{"method":"` + method + `","params":{"threadId":"` + notesThread + `"}}`
		if got := string(proc.withCodexContext([]byte(request), context)); got != request {
			t.Errorf("%s unexpectedly changed: %s", method, got)
		}
	}
	disabled := testCodexContext(t, proc.withCodexContext([]byte(start), codexContext{Files: "File links"}))
	if disabled[codexCLI].Value != cliDisabled {
		t.Fatalf("did not revoke earlier CLI guidance: %#v", disabled)
	}
}

func TestCodexContextUsesHostedProfileAndForkBoundary(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "foreign profile")
	parentDir := filepath.Join(profile, "sessions", stagedDir)
	forkDir := filepath.Join(profile, "sessions", "2026", "11", "19")
	for _, dir := range []string{parentDir, forkDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	const filePrompt = "File links"
	const cli = "Current CLI guidance"
	const commands = "Worktree guidance"
	parent := `{"type":"session_meta","ordinal":0,"payload":{}}` + "\n" +
		testCodexContextRecord(1, codexFileLinks, filePrompt) +
		testCodexContextRecord(2, codexCLI, cli) +
		testCodexContextRecord(3, codexCommands, commands)
	fork := `{"type":"session_meta","ordinal":3,"payload":{"forked_from_id":"` + notesThread +
		`","history_base":{"end_byte_offset":` + strconv.Itoa(len(parent)) + `}}}` + "\n"
	for path, body := range map[string]string{
		filepath.Join(parentDir, "rollout-time-"+notesThread+".jsonl"): parent +
			testCodexContextRecord(4, codexCLI, "Parent changed after fork"),
		filepath.Join(forkDir, "rollout-time-"+notesFork+".jsonl"): fork,
	} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}

	proc := testCodexContextProcess(profile)
	turn := `{"method":"turn/start","params":{"threadId":"` + notesFork + `"}}`
	context := codexContext{Files: filePrompt, CLI: &codexCLIContext{Status: cli, Commands: commands}}
	if got := string(proc.withCodexContext([]byte(turn), context)); got != turn {
		t.Fatalf("repeated inherited guidance: %s", got)
	}
	changed := testCodexContext(t, proc.withCodexContext([]byte(turn), codexContext{Files: filePrompt, CLI: &codexCLIContext{Status: "Other tab", Commands: commands}}))
	if len(changed) != 1 || changed[codexCLI].Kind != "application" {
		t.Fatalf("did not refresh only the CLI guidance: %#v", changed)
	}
	disabled := testCodexContext(t, proc.withCodexContext([]byte(turn), codexContext{Files: filePrompt}))
	if len(disabled) != 1 || disabled[codexCLI].Value != cliDisabled {
		t.Fatalf("did not revoke inherited CLI guidance: %#v", disabled)
	}
}

func TestCodexContextDisabledForNewThread(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	turn := `{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`
	fragments := testCodexContext(t, proc.withCodexContext([]byte(turn), codexContext{Files: "File links"}))
	if len(fragments) != 1 || fragments[codexFileLinks].Value != "File links" {
		t.Fatalf("expected file guidance only: %#v", fragments)
	}
}

func TestCodexContextWriteKeepsJSONLFraming(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	var stdin bytes.Buffer
	proc.stdin = testCodexStdin{&stdin}
	turn := `{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`
	if err := proc.write([]byte(turn), &codexContext{Files: "File links"}); err != nil {
		t.Fatal(err)
	}
	if err := proc.write([]byte(`{"method":"initialized"}`), nil); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(&stdin)
	first, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	if got := testCodexContext(t, first)[codexFileLinks].Value; got != "File links" {
		t.Fatalf("missing guidance: %q", got)
	}
	second, err := reader.ReadString('\n')
	if err != nil || second != `{"method":"initialized"}`+"\n" {
		t.Fatalf("second request is not its own JSON line: %q, %v", second, err)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("extra data after the requests: %v", err)
	}
}

type testCodexStdin struct{ *bytes.Buffer }

func (testCodexStdin) Close() error { return nil }

func TestCodexContextAfterCompaction(t *testing.T) {
	profile := t.TempDir()
	dir := filepath.Join(profile, "sessions", "2026", "11", "19")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-time-"+notesThread+".jsonl")
	const filePrompt = "File links"
	previous := testCodexContextRecord(1, codexFileLinks, filePrompt)
	if err := os.WriteFile(path, []byte(previous), 0600); err != nil {
		t.Fatal(err)
	}
	proc := testCodexContextProcess(profile)
	turn := `{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`
	context := codexContext{Files: filePrompt}
	if got := string(proc.withCodexContext([]byte(turn), context)); got != turn {
		t.Fatalf("repeated existing guidance: %s", got)
	}

	replaced := previous + `{"type":"compacted","payload":{"replacement_history":[]}}` + "\n"
	if err := os.WriteFile(path, []byte(replaced), 0600); err != nil {
		t.Fatal(err)
	}
	compacted := []byte(`{"method":"item/completed","params":{"item":{"type":"contextCompaction"}}}`)
	if !isCodexCompaction(compacted) {
		t.Fatal("did not recognize the compacted notification")
	}
	proc.codexCompactions.Add(1)
	result := proc.withCodexContext([]byte(turn), context)
	if got := testCodexContext(t, result)[codexFileLinks].Value; got != filePrompt+refreshSuffix+"1" {
		t.Fatalf("did not refresh removed guidance: %q", got)
	}
	if got := proc.withCodexContext([]byte(turn), context); !bytes.Equal(result, got) {
		t.Fatalf("subsequent turns require the same value for Codex deduplication: %s", got)
	}

	retained := previous + `{"type":"compacted","payload":{"replacement_history":[` +
		`{"type":"message","role":"developer","content":[{"text":"<nexus-file-links>File links</nexus-file-links>"}]}]}}` + "\n"
	if err := os.WriteFile(path, []byte(retained), 0600); err != nil {
		t.Fatal(err)
	}
	proc.codexCompactions.Add(1)
	if got := string(proc.withCodexContext([]byte(turn), context)); got != turn {
		t.Fatalf("repeated guidance kept in the replacement history: %s", got)
	}
}

func testCodexContextProcess(profile string) *process {
	return &process{cmd: &exec.Cmd{Env: []string{"CODEX_HOME=" + profile}}}
}

func testCodexContextRecord(ordinal int, key, value string) string {
	return `{"type":"response_item","ordinal":` + strconv.Itoa(ordinal) +
		`,"payload":{"type":"message","role":"developer","content":[{"text":"<` + key +
		`>` + value + `</` + key + `>"}]}}` + "\n"
}

func testCodexContext(t *testing.T, message []byte) map[string]struct{ Kind, Value string } {
	t.Helper()
	var decoded struct {
		Params struct {
			AdditionalContext map[string]struct{ Kind, Value string }
		}
	}
	if err := json.Unmarshal(message, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Params.AdditionalContext
}
