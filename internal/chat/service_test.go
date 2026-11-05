package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestFakeProgramHelper is the program the tests run: a stand-in for
// `claude -p` that answers each line it reads.
func TestFakeProgramHelper(t *testing.T) {
	if os.Getenv("NEXUS_CHAT_FAKE") != "1" {
		return
	}
	fmt.Fprintln(os.Stderr, "fake started")
	fmt.Println("not json")
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		var msg struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &msg)
		switch msg.Text {
		case "exit":
			fmt.Fprintln(os.Stderr, "fake exiting")
			os.Exit(3)
		case "env":
			fmt.Printf(`{"type":"env","path":%q,"tab":%q,"claudecode":%q}`+"\n",
				os.Getenv("PATH"), os.Getenv("NEXUS_TAB_ID"), os.Getenv("CLAUDECODE"))
			continue
		case "hang":
			time.Sleep(time.Hour)
		}
		fmt.Printf(`{"type":"stream_event","event":{"delta":%q}}`+"\n", msg.Text)
		fmt.Printf(`{"type":"stream_event","event":{"delta":%q}}`+"\n", "!")
		fmt.Printf(`{"type":"assistant","text":%q}`+"\n", msg.Text+"!")
	}
	os.Exit(0)
}

type recorder struct {
	mu     sync.Mutex
	lines  []LinePayload
	exits  []ExitPayload
	signal chan struct{}
}

func newRecorder() *recorder {
	return &recorder{signal: make(chan struct{}, 1024)}
}

func (r *recorder) sink(event string, payload any) error {
	r.mu.Lock()
	switch event {
	case EventLine:
		r.lines = append(r.lines, payload.(LinePayload))
	case EventExit:
		r.exits = append(r.exits, payload.(ExitPayload))
	}
	r.mu.Unlock()
	r.signal <- struct{}{}
	return nil
}

// waitFor waits until check holds for the recorded events.
func (r *recorder) waitFor(t *testing.T, what string, check func(lines []LinePayload, exits []ExitPayload) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		r.mu.Lock()
		ok := check(r.lines, r.exits)
		r.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-r.signal:
		case <-deadline:
			r.mu.Lock()
			defer r.mu.Unlock()
			t.Fatalf("timed out waiting for %s; lines: %v", what, describe(r.lines))
		}
	}
}

func (r *recorder) reset() {
	r.mu.Lock()
	r.lines = nil
	r.exits = nil
	r.mu.Unlock()
}

func describe(lines []LinePayload) string {
	parts := make([]string, 0, len(lines))
	for _, line := range lines {
		parts = append(parts, fmt.Sprintf("%d:%s:%s%s", line.Seq, line.Dir, line.Message, line.Text))
	}
	return strings.Join(parts, " | ")
}

func hasOut(lines []LinePayload, text string) bool {
	for _, line := range lines {
		if line.Dir == DirOut && strings.Contains(string(line.Message)+line.Text, text) {
			return true
		}
	}
	return false
}

func startFake(t *testing.T, service *Service, tabID string, env map[string]string) StartResult {
	t.Helper()
	if env == nil {
		env = map[string]string{}
	}
	env["NEXUS_CHAT_FAKE"] = "1"
	params, _ := json.Marshal(StartParams{
		WorkspaceID: "ws",
		TabID:       tabID,
		Cwd:         t.TempDir(),
		Program:     os.Args[0],
		Args:        []string{"-test.run=^TestFakeProgramHelper$"},
		Env:         env,
	})
	result, err := service.Start(context.Background(), params)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return result.(StartResult)
}

func send(t *testing.T, service *Service, tabID, text string) error {
	t.Helper()
	params, _ := json.Marshal(map[string]any{
		"workspaceId": "ws",
		"tabId":       tabID,
		"message":     map[string]string{"type": "user", "text": text},
	})
	_, err := service.Send(context.Background(), params)
	return err
}

func tabParams(tabID string) json.RawMessage {
	params, _ := json.Marshal(TabParams{WorkspaceID: "ws", TabID: tabID})
	return params
}

func TestStartSendRelaysLinesBothWays(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	if err := send(t, service, "tab", "hello"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	rec.waitFor(t, "the answer", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"text":"hello!"`)
	})

	rec.mu.Lock()
	defer rec.mu.Unlock()
	var sawStart, sawIn, sawText bool
	var last int64
	for _, line := range rec.lines {
		if line.Seq <= last {
			t.Fatalf("seq %d after %d", line.Seq, last)
		}
		last = line.Seq
		switch {
		case line.Dir == DirSys && strings.Contains(string(line.Message), `"event":"start"`):
			sawStart = true
		case line.Dir == DirIn && string(line.Message) == `{"text":"hello","type":"user"}`:
			sawIn = true
		case line.Dir == DirOut && line.Text == "not json":
			sawText = true
		}
	}
	if !sawStart || !sawIn || !sawText {
		t.Fatalf("start %v, in %v, text %v: %s", sawStart, sawIn, sawText, describe(rec.lines))
	}
}

func TestReplayDropsStreamEventsOfCompleteMessages(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "one")
	rec.waitFor(t, "the answer", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"text":"one!"`)
	})
	rec.mu.Lock()
	live := len(rec.lines)
	rec.mu.Unlock()
	rec.reset()

	result, err := service.Replay(context.Background(), tabParams("tab"))
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	replay := result.(ReplayResult)
	if !replay.Found || !replay.Running {
		t.Fatalf("replay = %+v", replay)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, line := range rec.lines {
		if !line.Replay {
			t.Fatalf("line %d not marked replay", line.Seq)
		}
		if strings.Contains(string(line.Message), "stream_event") {
			t.Fatalf("replay kept a stream event: %s", describe(rec.lines))
		}
	}
	if len(rec.lines) != live-2 {
		t.Fatalf("replayed %d lines, live had %d with 2 stream events", len(rec.lines), live)
	}
	if rec.lines[len(rec.lines)-1].Seq != replay.LastSeq {
		t.Fatalf("lastSeq %d, last replayed %d", replay.LastSeq, rec.lines[len(rec.lines)-1].Seq)
	}
}

func TestReplayAfterSeqSendsOnlyNewerLines(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "one")
	rec.waitFor(t, "the answer", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"text":"one!"`)
	})
	rec.mu.Lock()
	mark := rec.lines[len(rec.lines)-1].Seq
	rec.mu.Unlock()
	_ = send(t, service, "tab", "two")
	rec.waitFor(t, "the second answer", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"text":"two!"`)
	})
	rec.reset()

	params, _ := json.Marshal(ReplayParams{WorkspaceID: "ws", TabID: "tab", AfterSeq: mark})
	if _, err := service.Replay(context.Background(), params); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.lines) == 0 || hasOut(rec.lines, `"text":"one!"`) || !hasOut(rec.lines, `"text":"two!"`) {
		t.Fatalf("replay after %d: %s", mark, describe(rec.lines))
	}
}

func TestStartAttachesToRunningProgram(t *testing.T) {
	service := New()
	service.SetEventSink(newRecorder().sink)
	defer service.Close()

	first := startFake(t, service, "tab", nil)
	second := startFake(t, service, "tab", nil)
	if !second.Attached || second.PID != first.PID {
		t.Fatalf("second start = %+v, first %+v", second, first)
	}
}

func TestExitIsReportedAndLogKept(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "exit")
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
	rec.mu.Lock()
	exit := rec.exits[0]
	rec.mu.Unlock()
	if exit.Code == nil || *exit.Code != 3 {
		t.Fatalf("exit = %+v", exit)
	}
	if !strings.Contains(exit.StderrTail, "fake exiting") {
		t.Fatalf("stderr tail = %q", exit.StderrTail)
	}
	if err := send(t, service, "tab", "after"); err == nil {
		t.Fatal("Send to an exited program succeeded")
	}

	rec.reset()
	result, _ := service.Replay(context.Background(), tabParams("tab"))
	if replay := result.(ReplayResult); !replay.Found || replay.Running {
		t.Fatalf("replay = %+v", replay)
	}
	rec.mu.Lock()
	lines := rec.lines
	rec.mu.Unlock()
	last := lines[len(lines)-1]
	if last.Dir != DirSys || !strings.Contains(string(last.Message), `"event":"exit"`) {
		t.Fatalf("last replayed line = %s", describe(lines[len(lines)-1:]))
	}

	// Started again, the tab goes on in the same log.
	again := startFake(t, service, "tab", nil)
	if again.Attached {
		t.Fatal("start after exit attached")
	}
	_ = send(t, service, "tab", "back")
	rec.waitFor(t, "the answer after restart", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"text":"back!"`)
	})
	if lines[0].Seq == 0 {
		t.Fatal("seq 0")
	}
}

func TestStopEndsAHungProgram(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signals")
	}
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "hang")
	started := time.Now()
	if _, err := service.Stop(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if time.Since(started) > 8*time.Second {
		t.Fatalf("stop took %s", time.Since(started))
	}
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
	if result, _ := service.Replay(context.Background(), tabParams("tab")); !result.(ReplayResult).Found {
		t.Fatal("stop dropped the log")
	}
}

func TestCloseForgetsTheTab(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	if _, err := service.CloseTab(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
	if result, _ := service.Replay(context.Background(), tabParams("tab")); result.(ReplayResult).Found {
		t.Fatal("closed tab still has a log")
	}
	list, _ := service.List(context.Background(), nil)
	if n := len(list.(ListResult).Sessions); n != 0 {
		t.Fatalf("list has %d sessions", n)
	}
}

func TestEnvPutsWrapperFirstAndDropsParentSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PATH separator")
	}
	t.Setenv("CLAUDECODE", "1")
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	wrapper := t.TempDir()
	startFake(t, service, "tab", map[string]string{
		"PATH":                   "/usr/bin:/bin",
		"NEXUS_WRAPPER_SELF_DIR": wrapper,
		"NEXUS_TAB_ID":           "tab",
	})
	_ = send(t, service, "tab", "env")
	rec.waitFor(t, "the env", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"type":"env"`)
	})
	rec.mu.Lock()
	defer rec.mu.Unlock()
	want := fmt.Sprintf(`{"type":"env","path":%q,"tab":"tab","claudecode":""}`, wrapper+":/usr/bin:/bin")
	if !hasOut(rec.lines, want) {
		t.Fatalf("want %s in %s", want, describe(rec.lines))
	}
}

func TestSendRefusesNonJSON(t *testing.T) {
	service := New()
	params := []byte(`{"workspaceId":"ws","tabId":"tab","message":"{not"}`)
	if _, err := service.Send(context.Background(), params); err == nil {
		t.Fatal("Send took a string message for a tab with no program")
	}
	params = []byte(`{"workspaceId":"ws","tabId":"tab","message":{"a":1}}`)
	if _, err := service.Send(context.Background(), params); err == nil || !strings.Contains(err.Error(), "no program") {
		t.Fatalf("Send without a program: %v", err)
	}
}

func TestLogCapDropsOldestLines(t *testing.T) {
	log := newLineLog()
	log.cap = 1000
	for i := 0; i < 50; i++ {
		log.add(DirOut, json.RawMessage(fmt.Sprintf(`{"type":"assistant","n":%d}`, i)), "")
	}
	if !log.truncated || log.bytes > log.cap {
		t.Fatalf("truncated %v, bytes %d", log.truncated, log.bytes)
	}
	entries := log.since(0)
	if got := string(entries[len(entries)-1].message); got != `{"type":"assistant","n":49}` {
		t.Fatalf("newest = %s", got)
	}
	if entries[0].seq == 1 {
		t.Fatal("oldest line kept")
	}
}

func TestLogKeepsStreamOfMessageInProgress(t *testing.T) {
	log := newLineLog()
	log.add(DirOut, json.RawMessage(`{"type":"stream_event","n":1}`), "")
	log.add(DirIn, json.RawMessage(`{"type":"user"}`), "")
	log.add(DirOut, json.RawMessage(`{"type":"assistant"}`), "")
	log.add(DirOut, json.RawMessage(`{"type":"stream_event","n":2}`), "")
	var kinds []string
	for _, e := range log.since(0) {
		kinds = append(kinds, messageType(e.message))
	}
	if got := strings.Join(kinds, ","); got != "user,assistant,stream_event" {
		t.Fatalf("log = %s", got)
	}
}

func TestMessageType(t *testing.T) {
	cases := map[string]string{
		`{"type":"assistant","message":{}}`:        "assistant",
		`{"message":{"type":"x"},"type":"result"}`: "result",
		`{"type":"a\"b"}`:                          `a"b`,
		`not json`:                                 "",
	}
	for input, want := range cases {
		if got := messageType(json.RawMessage(input)); got != want {
			t.Errorf("messageType(%s) = %q, want %q", input, got, want)
		}
	}
}

func TestExecReturnsOutput(t *testing.T) {
	service := New()
	params, _ := json.Marshal(ExecParams{
		Program: os.Args[0],
		Args:    []string{"-test.run=^TestFakeProgramHelper$"},
		Env:     map[string]string{"NEXUS_CHAT_FAKE": "1"},
	})
	result, err := service.Exec(context.Background(), params)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	got := result.(ExecResult)
	if got.Code != 0 || !strings.Contains(got.Stdout, "not json") || !strings.Contains(got.Stderr, "fake started") {
		t.Fatalf("exec = %+v", got)
	}

	params, _ = json.Marshal(ExecParams{Program: filepath.Join(t.TempDir(), "missing")})
	result, _ = service.Exec(context.Background(), params)
	if got := result.(ExecResult); got.Code != -1 || got.Stderr == "" {
		t.Fatalf("missing program = %+v", got)
	}
}

func TestTranscriptFindsSessionInAnyProject(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "projects", "-some-project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	content := `{"type":"user","n":1}` + "\n" + "garbage\n" + `{"type":"assistant","n":2}` + "\n"
	if err := os.WriteFile(filepath.Join(project, id+".jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	service := New()
	params, _ := json.Marshal(TranscriptParams{SessionID: id, ConfigDir: dir})
	result, err := service.Transcript(context.Background(), params)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	got := result.(TranscriptResult)
	if !got.Found || len(got.Lines) != 2 || string(got.Lines[1]) != `{"type":"assistant","n":2}` {
		t.Fatalf("transcript = %+v", got)
	}

	params, _ = json.Marshal(TranscriptParams{SessionID: "../../etc/passwd", ConfigDir: dir})
	if _, err := service.Transcript(context.Background(), params); err == nil {
		t.Fatal("Transcript took a path for a session id")
	}
}

func TestReadJSONLinesKeepsTheEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	var b strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, `{"n":%d}`+"\n", i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, err := readJSONLines(path, 50)
	if err != nil || !truncated {
		t.Fatalf("err %v, truncated %v", err, truncated)
	}
	if len(lines) == 0 || string(lines[len(lines)-1]) != `{"n":99}` {
		t.Fatalf("lines = %s", lines)
	}
	for _, line := range lines {
		if !json.Valid(line) {
			t.Fatalf("partial line %s", line)
		}
	}
}
