package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

const notesThread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const notesFork = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func TestCodexContextAugmentsOnlyTurnStart(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	context := codexContext{Files: "File links", CLI: &codexCLIContext{Status: "CLI guidance", Commands: "Commands"}}
	start := `{"method":"turn/start","id":"turn","params":{"threadId":"` + notesThread +
		`","input":[{"type":"text","text":"Hello"}],"additionalContext":{"other":{"kind":"untrusted","value":"other context"}}}}`
	fragments := testCodexContext(t, applyTestCodexContext(proc, []byte(start), context))
	if len(fragments) != 4 || fragments["other"].Value != "other context" ||
		fragments[codexFileLinks].Kind != "application" || fragments[codexCLI].Kind != "application" {
		t.Fatalf("unexpected fragments: %#v", fragments)
	}
	for _, method := range []string{"thread/start", "thread/resume", "thread/fork", "turn/steer"} {
		request := `{"method":"` + method + `","params":{"threadId":"` + notesThread + `"}}`
		if got := string(applyTestCodexContext(proc, []byte(request), context)); got != request {
			t.Errorf("%s unexpectedly changed: %s", method, got)
		}
	}
	disabled := testCodexContext(t, applyTestCodexContext(proc, []byte(start), codexContext{Files: "File links"}))
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
	if got := string(applyTestCodexContext(proc, []byte(turn), context)); got != turn {
		t.Fatalf("repeated inherited guidance: %s", got)
	}
	changed := testCodexContext(t, applyTestCodexContext(proc, []byte(turn), codexContext{Files: filePrompt, CLI: &codexCLIContext{Status: "Other tab", Commands: commands}}))
	if len(changed) != 1 || changed[codexCLI].Kind != "application" {
		t.Fatalf("did not refresh only the CLI guidance: %#v", changed)
	}
	disabled := testCodexContext(t, applyTestCodexContext(proc, []byte(turn), codexContext{Files: filePrompt}))
	if len(disabled) != 1 || disabled[codexCLI].Value != cliDisabled {
		t.Fatalf("did not revoke inherited CLI guidance: %#v", disabled)
	}
}

func TestCodexContextDisabledForNewThread(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	turn := `{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`
	fragments := testCodexContext(t, applyTestCodexContext(proc, []byte(turn), codexContext{Files: "File links"}))
	if len(fragments) != 1 || fragments[codexFileLinks].Value != "File links" {
		t.Fatalf("expected file guidance only: %#v", fragments)
	}
}

func TestCodexContextWriteKeepsJSONLFraming(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	var stdin bytes.Buffer
	proc.stdin = testCodexStdin{&stdin}
	turn := `{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`
	if _, err := proc.writeLocked(context.Background(), []byte(turn), &codexContext{Files: "File links"}); err != nil {
		t.Fatal(err)
	}
	if _, err := proc.writeLocked(context.Background(), []byte(`{"method":"initialized"}`), nil); err != nil {
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

func (w testCodexStdin) WriteContext(_ context.Context, p []byte) (int, error) {
	return w.Write(p)
}

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
	if got := string(applyTestCodexContext(proc, []byte(turn), context)); got != turn {
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
	result := applyTestCodexContext(proc, []byte(turn), context)
	if got := testCodexContext(t, result)[codexFileLinks].Value; got != filePrompt+refreshSuffix+"1" {
		t.Fatalf("did not refresh removed guidance: %q", got)
	}
	if got := applyTestCodexContext(proc, []byte(turn), context); string(got) != turn {
		t.Fatalf("subsequent turns repeated refreshed guidance: %s", got)
	}

	retained := previous + `{"type":"compacted","payload":{"replacement_history":[` +
		`{"type":"message","role":"developer","content":[{"text":"<nexus-file-links>File links</nexus-file-links>"}]}]}}` + "\n"
	if err := os.WriteFile(path, []byte(retained), 0600); err != nil {
		t.Fatal(err)
	}
	proc.codexCompactions.Add(1)
	if got := string(applyTestCodexContext(proc, []byte(turn), context)); got != turn {
		t.Fatalf("repeated guidance kept in the replacement history: %s", got)
	}
}

func testCodexContextProcess(profile string) *process {
	return &process{cmd: &exec.Cmd{Env: []string{"CODEX_HOME=" + profile}}, codexInitialized: true, codexExperimental: true}
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

// A program started before the app asked for experimentalApi, or one whose
// initialize this agent never saw, rejects every turn that carries
// additionalContext: such a turn goes without the guidance.
func TestCodexContextWaitsForAnInitializeThatAskedForExperimentalApi(t *testing.T) {
	const turn = `{"method":"turn/start","id":"turn","params":{"threadId":"` + notesThread + `","input":[]}}`
	context := codexContext{Files: "File links"}
	initialize := func(capabilities string) []byte {
		return []byte(`{"method":"initialize","id":"1","params":{"clientInfo":{"name":"nexus-code"},"capabilities":` + capabilities + `}}`)
	}
	cases := []struct {
		name       string
		requests   [][]byte
		guidanceOn bool
	}{
		{"initialize not seen", nil, false},
		{"capabilities null", [][]byte{initialize(`null`)}, false},
		{"experimentalApi false", [][]byte{initialize(`{"experimentalApi":false}`)}, false},
		{"experimentalApi true", [][]byte{initialize(`{"experimentalApi":true}`)}, true},
		{"later initialize does not count", [][]byte{initialize(`null`), initialize(`{"experimentalApi":true}`)}, false},
		{"unrelated lines do not count", [][]byte{[]byte(`{"method":"turn/start","params":{"input":[{"text":"initialize"}]}}`)}, false},
	}
	for _, c := range cases {
		proc := &process{cmd: &exec.Cmd{Env: []string{"CODEX_HOME=" + t.TempDir()}}}
		for _, request := range c.requests {
			proc.noteCodexInitialize(request)
		}
		got := applyTestCodexContext(proc, []byte(turn), context)
		if c.guidanceOn != (string(got) != turn) {
			t.Errorf("%s: guidance added = %v, want %v: %s", c.name, string(got) != turn, c.guidanceOn, got)
		}
	}
}

// applyTestCodexContext models guidance accepted by the child.
func applyTestCodexContext(p *process, data []byte, guidance codexContext) []byte {
	edited, commit := p.prepareCodexContext(data, guidance)
	if commit != nil {
		commit()
	}
	return edited
}

func TestCodexInstructionsChangeIndependently(t *testing.T) {
	proc := testCodexContextProcess(t.TempDir())
	turn := []byte(`{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`)
	context := codexContext{Files: "File links"}
	check := func(want map[string]string) {
		t.Helper()
		got := testCodexContext(t, applyTestCodexContext(proc, turn, context))
		if len(got) != len(want) {
			t.Fatalf("unexpected fragments: %#v", got)
		}
		for key, value := range want {
			if got[key].Value != value || got[key].Kind != "application" {
				t.Fatalf("fragment %s = %#v, want %q", key, got[key], value)
			}
		}
	}
	check(map[string]string{codexFileLinks: context.Files})
	context.Instructions = "First instructions"
	check(map[string]string{codexInstructions: context.Instructions})
	check(nil)
	context.Instructions = "Updated instructions"
	check(map[string]string{codexInstructions: instructionsReplaced + context.Instructions})
	proc.codexCompactions.Add(1)
	check(map[string]string{
		codexFileLinks:    context.Files + refreshSuffix + "1",
		codexInstructions: instructionsReplaced + context.Instructions + refreshSuffix + "1",
	})
	check(nil)
	context.Instructions = ""
	check(map[string]string{codexInstructions: instructionsCleared + refreshSuffix + "1"})
	check(nil)
}

func TestCodexLongInstructionsSurviveResumeAndRefresh(t *testing.T) {
	profile := t.TempDir()
	turn := []byte(`{"method":"turn/start","params":{"threadId":"` + notesThread + `"}}`)
	guidance := codexContext{Instructions: "# Instructions\n" + strings.Repeat("한🧪", 1600) + "\nlast rule"}
	proc := testCodexContextProcess(profile)
	fragments := testCodexContext(t, applyTestCodexContext(proc, turn, guidance))
	if len(fragments) < 3 {
		t.Fatalf("instructions did not split: %d fragments", len(fragments))
	}
	keys := make([]string, 0, len(fragments))
	for key := range fragments {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	var text strings.Builder
	var rollout strings.Builder
	dir := filepath.Join(profile, "sessions", "2026", "11", "19")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "rollout-time-"+notesThread+".jsonl")
	for i, key := range keys {
		part := fragments[key]
		if len(part.Value) > 4000 || !utf8.ValidString(part.Value) || part.Kind != "application" {
			t.Fatalf("invalid additionalContext part %s", key)
		}
		text.WriteString(part.Value)
		item := map[string]any{"type": "message", "role": "developer", "content": []map[string]string{
			{"text": "<" + key + ">" + part.Value + "</" + key + ">"},
		}}
		record, _ := json.Marshal(map[string]any{"type": "response_item", "payload": item})
		rollout.Write(record)
		rollout.WriteByte('\n')
		if i == 0 {
			if err := os.WriteFile(file, record, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if text.String() != guidance.Instructions {
		t.Fatal("splitting changed the instructions")
	}
	if bytes.Equal(applyTestCodexContext(testCodexContextProcess(profile), turn, guidance), turn) {
		t.Fatal("a partial rollout suppressed the rest of the instructions")
	}
	if err := os.WriteFile(file, []byte(rollout.String()), 0600); err != nil {
		t.Fatal(err)
	}
	resumed := testCodexContextProcess(profile)
	if !bytes.Equal(applyTestCodexContext(resumed, turn, guidance), turn) {
		t.Fatal("resume repeated instructions already in the rollout")
	}
	guidance.Instructions = ""
	got := testCodexContext(t, applyTestCodexContext(resumed, turn, guidance))
	if len(got) != 1 || got[codexInstructions].Value != instructionsCleared {
		t.Fatal("clearing a split update should revoke all its instructions")
	}
}
