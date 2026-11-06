//go:build !windows

package hookclient

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// frameServer answers every hook frame sent to it, as the agent's
// hookserver would, and keeps them. It holds a run's watch unanswered, as
// the hookserver does, and logs it and its closing among the frames.
type frameServer struct {
	mu     sync.Mutex
	frames []hookRequest
	log    []string
	// watch is the latest run's watch.
	watch net.Conn
}

func newFrameServer(t *testing.T) (*frameServer, string) {
	t.Helper()
	srv := newMockServer(t)
	fs := &frameServer{}
	go func() {
		for {
			conn, err := srv.listener.Accept()
			if err != nil {
				return
			}
			scanner := bufio.NewScanner(conn)
			scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
			if scanner.Scan() {
				var req hookRequest
				if json.Unmarshal(scanner.Bytes(), &req) == nil {
					fs.mu.Lock()
					fs.log = append(fs.log, req.Subcommand)
					if req.Subcommand == "print-watch" {
						fs.watch = conn
						fs.mu.Unlock()
						go fs.hold(conn)
						continue
					}
					fs.frames = append(fs.frames, req)
					fs.mu.Unlock()
				}
				_, _ = conn.Write([]byte(`{"ok":true}` + "\n"))
			}
			conn.Close()
		}
	}()
	return fs, srv.socketPath
}

// answerWatch writes `answer` on the latest watch, as the agent answers one.
func (fs *frameServer) answerWatch(answer string) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	_, _ = fs.watch.Write([]byte(answer + "\n"))
}

// hold keeps a watch open until its client closes it.
func (fs *frameServer) hold(conn net.Conn) {
	defer conn.Close()
	_, _ = io.Copy(io.Discard, conn)
	fs.mu.Lock()
	fs.log = append(fs.log, "print-watch closed")
	fs.mu.Unlock()
}

// logged is what the server heard, in order.
func (fs *frameServer) logged() string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return strings.Join(fs.log, ",")
}

func (fs *frameServer) told(t *testing.T) []toldFrame {
	t.Helper()
	fs.mu.Lock()
	defer fs.mu.Unlock()
	told := make([]toldFrame, 0, len(fs.frames))
	for _, req := range fs.frames {
		if req.Token != "tok" || req.WorkspaceID != "ws" || req.TabID != "t1" || req.Type != "hook" {
			t.Fatalf("frame sent as %+v", req)
		}
		var payload map[string]any
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			t.Fatalf("payload %s: %v", req.Payload, err)
		}
		told = append(told, toldFrame{req.Subcommand, payload})
	}
	return told
}

// fakeClaude writes a script that stands for claude. Claude Code's
// directory, where a run's transcript is looked for, is the test's own.
func fakeClaude(t *testing.T, body string) string {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	path := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunPrint_PassesTheRunOnAndTellsIt(t *testing.T) {
	fs, socket := newFrameServer(t)
	stream := strings.Join(streamLines, "\n") + "\n"
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "out.jsonl"), []byte(stream), 0o644); err != nil {
		t.Fatal(err)
	}
	claude := fakeClaude(t, `cat "`+dir+`/out.jsonl"; cat >&2; echo "args: $*" >&2; exit 3`)
	teller := newPrintTeller(socket, "tok", "ws", "t1")
	var stdout, stderr bytes.Buffer
	code, sig := runPrint(
		claude,
		[]string{"-p", "review it", "--output-format", "stream-json", "--verbose"},
		strings.NewReader("from stdin\n"),
		&stdout,
		&stderr,
		teller,
	)
	if code != 3 || sig != 0 {
		t.Fatalf("exit = %d, signal %d", code, sig)
	}
	if stdout.String() != stream {
		t.Fatalf("stdout = %q", stdout.String())
	}
	// It starts a session of its own, given its id.
	given := regexp.MustCompile(`^from stdin\nargs: --session-id ([0-9a-f-]{36}) -p review it --output-format stream-json --verbose\n$`).
		FindStringSubmatch(stderr.String())
	if given == nil {
		t.Fatalf("stderr = %q", stderr.String())
	}

	told := fs.told(t)
	subcommands := make([]string, len(told))
	for i, frame := range told {
		subcommands[i] = frame.Subcommand
		if frame.Payload["run_id"] != teller.runID {
			t.Fatalf("frame %d of run %v", i, frame.Payload["run_id"])
		}
	}
	want := []string{
		"print-start", "print-init", "print-text",
		"print-tool-use", "print-tool-result",
		"print-tool-use", "print-tool-result",
		"print-end",
	}
	if strings.Join(subcommands, ",") != strings.Join(want, ",") {
		t.Fatalf("told %v", subcommands)
	}
	start := told[0].Payload
	if start["prompt"] != "review it" || start["tools_told"] != true || start["cwd"] == "" ||
		start["session_id"] != given[1] || start["resumed"] != nil {
		t.Fatalf("start = %v", start)
	}
	end := told[len(told)-1].Payload
	if end["exit_code"] != float64(3) || end["answer"] != "Done." || end["signal"] != nil {
		t.Fatalf("end = %v", end)
	}
}

func TestRunPrint_TextRunTellsItsOutputAsItsAnswer(t *testing.T) {
	fs, socket := newFrameServer(t)
	// Output that reads as stream-json is a text run's answer all the same.
	out := "{\"type\":\"result\",\"result\":\"no\"}\nLooks fine.\n"
	claude := fakeClaude(t, `printf '%s' '`+out+`'`)
	var stdout bytes.Buffer
	code, _ := runPrint(claude, []string{"-p", "hi"}, strings.NewReader(""), &stdout, &bytes.Buffer{},
		newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 0 || stdout.String() != out {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
	told := fs.told(t)
	if len(told) != 2 || told[0].Subcommand != "print-start" || told[1].Subcommand != "print-end" {
		t.Fatalf("told %v", told)
	}
	if told[0].Payload["tools_told"] != false || told[1].Payload["answer"] != strings.TrimSpace(out) {
		t.Fatalf("told %v", told)
	}
}

func TestRunPrint_LeavesATerminalToClaude(t *testing.T) {
	tty, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		t.Skip(err)
	}
	defer tty.Close()
	if !isTerminal(tty) {
		t.Skip("/dev/null is no character device here")
	}
	fs, socket := newFrameServer(t)
	// Claude finds the terminal it was given: its stdout is the device itself.
	claude := fakeClaude(t, `[ -c /dev/stdout ] || exit 9; echo answer`)
	code, _ := runPrint(claude, []string{"-p", "hi"}, strings.NewReader(""), tty, &bytes.Buffer{},
		newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if told := fs.told(t); told[len(told)-1].Payload["answer"] != nil {
		t.Fatalf("told %v", told)
	}
}

func TestRunPrint_TellsTheSignalClaudeDiedOf(t *testing.T) {
	fs, socket := newFrameServer(t)
	claude := fakeClaude(t, `kill -TERM $$`)
	code, sig := runPrint(claude, []string{"-p", "hi", "--output-format", "stream-json"},
		strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, newPrintTeller(socket, "tok", "ws", "t1"))
	if sig != int(syscall.SIGTERM) || code != -1 {
		t.Fatalf("exit %d, signal %d", code, sig)
	}
	told := fs.told(t)
	end := told[len(told)-1]
	if end.Subcommand != "print-end" || end.Payload["signal"] != "terminated" || end.Payload["exit_code"] != nil {
		t.Fatalf("end = %v", end)
	}
}

func TestRunPrint_TellsTheSignalTheRunGot(t *testing.T) {
	fs, socket := newFrameServer(t)
	started := filepath.Join(t.TempDir(), "started")
	// Claude ends by the signal with an exit code of its own.
	claude := fakeClaude(t, `trap 'exit 143' TERM; touch "`+started+`"; sleep 5 >/dev/null 2>&1 & wait`)
	go func() {
		for i := 0; i < 100; i++ {
			if _, err := os.Stat(started); err == nil {
				_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
	code, sig := runPrint(claude, []string{"-p", "hi"}, strings.NewReader(""), &bytes.Buffer{},
		&bytes.Buffer{}, newPrintTeller(socket, "tok", "ws", "t1"))
	if code != 143 || sig != 0 {
		t.Fatalf("exit %d, signal %d", code, sig)
	}
	told := fs.told(t)
	end := told[len(told)-1].Payload
	if end["exit_code"] != float64(143) || end["signal"] != "terminated" {
		t.Fatalf("end = %v", end)
	}
}

func TestRunPrint_HoldsAWatchUntilItsEnd(t *testing.T) {
	fs, socket := newFrameServer(t)
	dir := t.TempDir()
	claude := fakeClaude(t, `while [ ! -e "`+dir+`/go" ]; do sleep 0.02; done`)
	ran := make(chan int, 1)
	go func() {
		code, _ := runPrint(claude, []string{"-p", "hi"}, strings.NewReader(""), &bytes.Buffer{},
			&bytes.Buffer{}, newPrintTeller(socket, "tok", "ws", "t1"))
		ran <- code
	}()
	// The app knows of the run before it is watched.
	waitFor(t, func() bool { return fs.logged() == "print-start,print-watch" })
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := <-ran; code != 0 {
		t.Fatalf("exit %d", code)
	}
	// Its end is told before the watch closes.
	waitFor(t, func() bool { return fs.logged() == "print-start,print-watch,print-end,print-watch closed" })
}

// waitFor waits up to 2s for ok.
func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// transcriptClaude is a claude that writes the transcript of the session
// it is given, `first` and then, once the test made the file `go` in dir,
// `rest`, then prints `out`, and its arguments to stderr.
func transcriptClaude(t *testing.T, dir string, first, rest []string, out string) string {
	t.Helper()
	for name, lines := range map[string][]string{"first": first, "rest": rest} {
		body := strings.Join(lines, "\n") + "\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	claude := fakeClaude(t, `echo "args: $*" >&2
id=""
while [ $# -gt 0 ]; do case "$1" in --session-id|--resume) id="$2";; esac; shift; done
d="$CLAUDE_CONFIG_DIR/projects/-repo"; mkdir -p "$d"
cat "`+dir+`/first" >> "$d/$id.jsonl"
while [ ! -e "`+dir+`/go" ]; do sleep 0.02; done
cat "`+dir+`/rest" >> "$d/$id.jsonl"
printf '%s' '`+out+`'`)
	return claude
}

func TestRunPrint_FollowsATextRunsTranscript(t *testing.T) {
	fs, socket := newFrameServer(t)
	dir := t.TempDir()
	claude := transcriptClaude(t, dir, transcriptLines[:5], transcriptLines[5:], "Printed answer.\n")
	var stdout, stderr bytes.Buffer
	ran := make(chan int, 1)
	go func() {
		code, _ := runPrint(claude, []string{"-p", "review it"}, strings.NewReader(""), &stdout,
			&stderr, newPrintTeller(socket, "tok", "ws", "t1"))
		ran <- code
	}()
	// Its tools are told as it runs them.
	waitFor(t, func() bool { return strings.HasSuffix(fs.logged(), "print-tool-use") })
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := <-ran; code != 0 || stdout.String() != "Printed answer.\n" {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
	if args := stderr.String(); !regexp.MustCompile(`^args: --session-id [0-9a-f-]{36} -p review it\n$`).MatchString(args) {
		t.Fatalf("claude ran with %q", args)
	}
	told := fs.told(t)
	var got []string
	for _, frame := range told {
		got = append(got, frame.String())
	}
	if len(told) != 9 ||
		told[0].Payload["tools_told"] != false ||
		told[1].Subcommand != "print-init" || told[1].Payload["tools_told"] != true ||
		told[2].Subcommand != "print-init" || told[2].Payload["model"] != "glm-4.6" ||
		told[3].Subcommand != "print-text" || told[3].Payload["text"] != "Looking." ||
		told[4].Subcommand != "print-tool-use" || told[5].Subcommand != "print-tool-result" ||
		told[6].Payload["text"] != "It is fine." || told[7].Payload["text"] != "Ship it." ||
		told[8].Subcommand != "print-end" || told[8].Payload["answer"] != "Printed answer." {
		t.Fatalf("told %v", got)
	}
}

func TestRunPrint_ATerminalRunsAnswerIsItsTranscripts(t *testing.T) {
	tty, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		t.Skip(err)
	}
	defer tty.Close()
	if !isTerminal(tty) {
		t.Skip("/dev/null is no character device here")
	}
	fs, socket := newFrameServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	claude := transcriptClaude(t, dir, transcriptLines, nil, "Ship it.\n")
	code, _ := runPrint(claude, []string{"-p", "review it"}, strings.NewReader(""), tty, &bytes.Buffer{},
		newPrintTeller(socket, "tok", "ws", "t1"))
	told := fs.told(t)
	if end := told[len(told)-1].Payload; code != 0 || end["answer"] != "It is fine.\nShip it." {
		t.Fatalf("exit %d, end %v", code, end)
	}
}

func TestRunPrint_FollowsTheSessionTheRunWasGiven(t *testing.T) {
	fs, socket := newFrameServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	claude := transcriptClaude(t, dir, transcriptLines, nil, "")
	var stderr bytes.Buffer
	runPrint(claude, []string{"-p", "hi", "--session-id", "s1"}, strings.NewReader(""), &bytes.Buffer{},
		&stderr, newPrintTeller(socket, "tok", "ws", "t1"))
	if stderr.String() != "args: -p hi --session-id s1\n" {
		t.Fatalf("claude ran with %q", stderr.String())
	}
	if told := fs.told(t); len(told) != 9 || told[8].Payload["answer"] != "It is fine.\nShip it." {
		t.Fatalf("told %v", told)
	}
}

func TestRunPrint_ARunThatGoesOnASessionIsFollowedFromWhereItWas(t *testing.T) {
	fs, socket := newFrameServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	claude := transcriptClaude(t, dir, transcriptLines[5:], nil, "")
	// The session's transcript as its first run left it.
	project := filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "projects", "-repo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	before := strings.Join(transcriptLines[:5], "\n") + "\n"
	if err := os.WriteFile(filepath.Join(project, sessionA+".jsonl"), []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	runPrint(claude, []string{"-p", "more", "--resume", sessionA}, strings.NewReader(""), &bytes.Buffer{},
		&stderr, newPrintTeller(socket, "tok", "ws", "t1"))
	if stderr.String() != "args: -p more --resume "+sessionA+"\n" {
		t.Fatalf("claude ran with %q", stderr.String())
	}
	told := fs.told(t)
	var got []string
	for _, frame := range told {
		got = append(got, frame.String())
	}
	if len(told) < 2 || told[0].Payload["session_id"] != sessionA || told[0].Payload["resumed"] != true ||
		told[len(told)-1].Payload["answer"] != "It is fine.\nShip it." {
		t.Fatalf("told %v", got)
	}
	// Only what this run added is told: not the first run's tool call.
	for _, frame := range told {
		if frame.Subcommand == "print-tool-use" {
			t.Fatalf("told %v", got)
		}
	}
}

func TestRunPrint_AppStopsTheRunByItsWatch(t *testing.T) {
	// A claude that ends on the interrupt, or once the test made the file
	// `go` in dir; `trap` is how it takes the interrupt.
	run := func(t *testing.T, trap, answer string, then func(dir string)) map[string]any {
		fs, socket := newFrameServer(t)
		dir := t.TempDir()
		claude := fakeClaude(t, trap+`touch "`+dir+`/ready"; while [ ! -e "`+dir+`/go" ]; do sleep 0.02; done`)
		ran := make(chan map[string]any, 1)
		go func() {
			runPrint(claude, []string{"-p", "hi"}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{},
				newPrintTeller(socket, "tok", "ws", "t1"))
			told := fs.told(t)
			ran <- told[len(told)-1].Payload
		}()
		waitFor(t, func() bool { return fs.logged() == "print-start,print-watch" })
		// Once claude has set its trap.
		waitFor(t, func() bool {
			_, err := os.Stat(filepath.Join(dir, "ready"))
			return err == nil
		})
		fs.answerWatch(answer)
		then(dir)
		select {
		case end := <-ran:
			return end
		case <-time.After(3 * time.Second):
			t.Fatal("the run did not end")
			return nil
		}
	}

	t.Run("an answer to stop it interrupts claude", func(t *testing.T) {
		// Whether claude dies of it or exits on it, the run reads interrupted.
		// A shell waiting on its sleep holds the interrupt; this one dies of it, as claude.
		end := run(t, `trap 'trap - INT; kill -INT $$' INT; `, `{"ok":true,"stdout":"stop"}`,
			func(string) {})
		if end["signal"] != "interrupt" {
			t.Fatalf("end = %v", end)
		}
	})

	t.Run("a claude that exits 0 on the interrupt reads stopped too", func(t *testing.T) {
		end := run(t, `trap 'echo Execution error; exit 0' INT; `, `{"ok":true,"stdout":"stop"}`,
			func(string) {})
		if end["signal"] != "interrupt" || end["exit_code"] != float64(0) {
			t.Fatalf("end = %v", end)
		}
	})

	t.Run("another answer, as the agent's when the app goes, leaves it be", func(t *testing.T) {
		end := run(t, "", `{"ok":true}`, func(dir string) {
			time.Sleep(150 * time.Millisecond)
			if err := os.WriteFile(filepath.Join(dir, "go"), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		})
		if end["signal"] != nil || end["exit_code"] != float64(0) {
			t.Fatalf("end = %v", end)
		}
	})
}

func TestRunPrint_AResumedRunIsGivenNoSession(t *testing.T) {
	fs, socket := newFrameServer(t)
	claude := fakeClaude(t, `echo "args: $*" >&2`)
	var stderr bytes.Buffer
	runPrint(claude, []string{"-p", "hi", "--resume", "s1"}, strings.NewReader(""), &bytes.Buffer{},
		&stderr, newPrintTeller(socket, "tok", "ws", "t1"))
	if stderr.String() != "args: -p hi --resume s1\n" {
		t.Fatalf("claude ran with %q", stderr.String())
	}
	if told := fs.told(t); len(told) != 2 {
		t.Fatalf("told %v", told)
	}
}

func TestRunPrint_RunsWithNoAppToTell(t *testing.T) {
	claude := fakeClaude(t, `echo out; exit 4`)
	var stdout bytes.Buffer
	code, _ := runPrint(claude, []string{"-p", "hi", "--output-format", "stream-json"},
		strings.NewReader(""), &stdout, &bytes.Buffer{}, newPrintTeller("", "", "", ""))
	if code != 4 || stdout.String() != "out\n" {
		t.Fatalf("exit %d, stdout %q", code, stdout.String())
	}
}

func TestRunPrint_AnAppGoneDoesNotHoldTheRun(t *testing.T) {
	claude := fakeClaude(t, `echo '{"type":"system","subtype":"init","model":"m"}'`)
	teller := newPrintTeller(filepath.Join(t.TempDir(), "gone.sock"), "tok", "ws", "t1")
	began := time.Now()
	code, _ := runPrint(claude, []string{"-p", "hi", "--output-format", "stream-json"},
		strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, teller)
	if code != 0 || time.Since(began) > 2*time.Second {
		t.Fatalf("exit %d after %v", code, time.Since(began))
	}
}

func TestRunPrint_ClaudeNotFound(t *testing.T) {
	var stderr bytes.Buffer
	code, _ := runPrint(filepath.Join(t.TempDir(), "none"), []string{"-p"}, strings.NewReader(""),
		&bytes.Buffer{}, &stderr, nil)
	if code != 127 || !strings.HasPrefix(stderr.String(), "nexus: ") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}

func (f toldFrame) String() string {
	b, _ := json.Marshal(f.Payload)
	return f.Subcommand + string(b)
}
