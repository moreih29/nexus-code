//go:build !windows

package hookclient

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeCodex writes a script that stands for codex, in a codex home of the
// test's own.
func fakeCodex(t *testing.T, body string) string {
	t.Helper()
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("OPENAI_BASE_URL", "")
	path := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func subcommandsOf(told []toldFrame) string {
	names := make([]string, len(told))
	for i, frame := range told {
		names[i] = frame.Subcommand
	}
	return strings.Join(names, ",")
}

func TestRunCodexExec_PassesTheRunOnAndTellsItsEvents(t *testing.T) {
	fs, socket := newFrameServer(t)
	stream := strings.Join(codexEvents, "\n") + "\n"
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "out.jsonl"), []byte(stream), 0o644); err != nil {
		t.Fatal(err)
	}
	// It reads its prompt from stdin, as codex does, and exits as it would.
	codex := fakeCodex(t, `cat > "`+dir+`/prompt.txt"; cat "`+dir+`/out.jsonl"; echo "args: $*" >&2; exit 1`)
	teller := newPrintTeller(socket, "tok", "ws", "t1")
	var stdout, stderr bytes.Buffer
	args := []string{"--no-daemon", "-m", "gpt-6-luna", "exec", "--json", "-"}
	code, sig := runCodexExec(codex, args, strings.NewReader("  Fix the failing test.\n"), &stdout, &stderr, teller)
	if code != 1 || sig != 0 {
		t.Fatalf("exit = %d, signal %d", code, sig)
	}
	if stdout.String() != stream || stderr.String() != "args: "+strings.Join(args, " ")+"\n" {
		t.Fatalf("stdout %q, stderr %q", stdout.String(), stderr.String())
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "prompt.txt")); string(got) != "  Fix the failing test.\n" {
		t.Fatalf("codex read %q", got)
	}

	told := fs.told(t)
	for i, frame := range told {
		if frame.Payload["run_id"] != teller.runID {
			t.Fatalf("frame %d of run %v", i, frame.Payload["run_id"])
		}
	}
	start, end := told[0], told[len(told)-1]
	if start.Subcommand != "print-start" || start.Payload["program"] != "codex" ||
		start.Payload["model"] != "gpt-6-luna" || start.Payload["tools_told"] != true ||
		start.Payload["prompt"] != "" || start.Payload["endpoint"] != nil {
		t.Fatalf("start = %v", start)
	}
	if end.Subcommand != "print-end" || end.Payload["exit_code"] != float64(1) ||
		end.Payload["answer"] != "Fixed the test." {
		t.Fatalf("end = %v", end)
	}
	var prompt, tools int
	for _, frame := range told {
		switch {
		case frame.Subcommand == "print-init" && frame.Payload["prompt"] != nil:
			prompt++
			if frame.Payload["prompt"] != "Fix the failing test." {
				t.Fatalf("prompt told %v", frame)
			}
		case frame.Subcommand == "print-tool-use":
			tools++
			if id, _ := frame.Payload["tool_use_id"].(string); !strings.HasPrefix(id, teller.runID+":item_") {
				t.Fatalf("tool told %v", frame)
			}
		}
	}
	if prompt != 1 || tools != 5 {
		t.Fatalf("told %s", subcommandsOf(told))
	}
}

func TestRunCodexExec_TextRunTellsItsHeaderAndAnswer(t *testing.T) {
	fs, socket := newFrameServer(t)
	header := "OpenAI Codex v0.166.0\n--------\nworkdir: /w\nmodel: gpt-6-luna\nprovider: openai\n" +
		"session id: 01a1b19e-e57a-74f2-af0e-e1be5b21d5ac\n--------\nuser\nhi\n"
	codex := fakeCodex(t, `printf '%s' '`+header+`' >&2; echo "All good."`)
	var stdout, stderr bytes.Buffer
	code, _ := runCodexExec(codex, []string{"exec", "hi"}, strings.NewReader(""), &stdout, &stderr,
		newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 0 || stdout.String() != "All good.\n" || stderr.String() != header {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
	}
	told := fs.told(t)
	if subcommandsOf(told) != "print-start,print-init,print-end" {
		t.Fatalf("told %v", told)
	}
	if told[0].Payload["prompt"] != "hi" || told[0].Payload["tools_told"] != false {
		t.Fatalf("start %v", told[0])
	}
	if told[1].Payload["model"] != "gpt-6-luna" ||
		told[1].Payload["session_id"] != "01a1b19e-e57a-74f2-af0e-e1be5b21d5ac" ||
		told[1].Payload["endpoint"] != nil {
		t.Fatalf("init %v", told[1])
	}
	if told[2].Payload["answer"] != "All good." {
		t.Fatalf("end %v", told[2])
	}
}

func TestRunCodexExec_TextRunTellsItsRollout(t *testing.T) {
	fs, socket := newFrameServer(t)
	const id = "01a1b1e2-7511-7531-92ee-5984efc1790d"
	header := "OpenAI Codex v0.166.0\n--------\nmodel: gpt-6-luna\nsession id: " + id + "\n--------\n"
	lines := strings.Join(rolloutLines, "\n") + "\n"
	// codex writes its rollout as it goes, after its header.
	codex := fakeCodex(t, `printf '%s' '`+header+`' >&2
day="$CODEX_HOME/sessions/2026/11/06"; mkdir -p "$day"
cat > "$day/rollout-2026-11-06T17-22-50-`+id+`.jsonl" <<'LINES'
`+lines+`LINES
echo DONE`)
	var stdout bytes.Buffer
	code, _ := runCodexExec(codex, []string{"exec", "make it"}, strings.NewReader(""), &stdout, &bytes.Buffer{},
		newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 0 || stdout.String() != "DONE\n" {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
	told := fs.told(t)
	want := "print-start,print-init,print-init,print-text," +
		"print-tool-use,print-tool-result,print-tool-use,print-tool-result," +
		"print-tool-use,print-tool-result,print-text,print-end"
	if subcommandsOf(told) != want {
		t.Fatalf("told %v", told)
	}
	if told[0].Payload["tools_told"] != false || told[1].Payload["session_id"] != id ||
		told[2].Payload["tools_told"] != true {
		t.Fatalf("told %v", told[:3])
	}
	if end := told[len(told)-1].Payload; end["answer"] != "DONE" {
		t.Fatalf("end %v", end)
	}
}

func TestRunCodexExec_TellsNothingOfAnotherCommand(t *testing.T) {
	fs, socket := newFrameServer(t)
	codex := fakeCodex(t, `echo "codex $*"`)
	var stdout bytes.Buffer
	code, _ := runCodexExec(codex, []string{"exec", "--help"}, strings.NewReader(""), &stdout, &bytes.Buffer{},
		newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 0 || stdout.String() != "codex exec --help\n" {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
	if told := fs.told(t); len(told) != 0 {
		t.Fatalf("told %v", told)
	}
}

func TestRunCodexExec_RunsWithNoAppToTell(t *testing.T) {
	codex := fakeCodex(t, `cat; echo " and done"`)
	var stdout bytes.Buffer
	code, _ := runCodexExec(codex, []string{"exec", "-"}, strings.NewReader("from stdin"), &stdout, &bytes.Buffer{}, nil)
	if code != 0 || stdout.String() != "from stdin and done\n" {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
}

func TestRunCodexExec_CodexNotFound(t *testing.T) {
	var stderr bytes.Buffer
	code, _ := runCodexExec(filepath.Join(t.TempDir(), "missing"), []string{"exec", "hi"},
		strings.NewReader(""), &bytes.Buffer{}, &stderr, nil)
	if code != 127 || !strings.HasPrefix(stderr.String(), "nexus: ") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}
