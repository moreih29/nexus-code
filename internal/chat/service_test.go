package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
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
		case "linger":
			// Outlast a stop's polite ask, to be killed after its grace.
			signal.Ignore(syscall.SIGTERM)
			fmt.Println(`{"type":"lingering"}`)
			continue
		case "line":
			fmt.Println(os.Getenv("NEXUS_CHAT_FAKE_LINE"))
			continue
		case "leave":
			// Exit, leaving a child that holds the input and both outputs.
			child := exec.Command(os.Args[0], "-test.run=^TestFakeChildHelper$")
			child.Env = append(os.Environ(), "NEXUS_CHAT_CHILD=1")
			child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
			if err := child.Start(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(4)
			}
			os.Exit(0)
		case "spawn":
			// Start a child that runs until it is ended, and tell its pid.
			child := exec.Command(os.Args[0], "-test.run=^TestFakeSleeperHelper$")
			child.Env = append(os.Environ(), "NEXUS_CHAT_SLEEPER=1")
			if os.Getenv("NEXUS_CHAT_RESIST_TERM") == "1" {
				child.Stdout = os.Stdout
			}
			// As Claude and Codex start each command, out of the program's group.
			if os.Getenv("NEXUS_CHAT_OWN_SESSION") == "1" {
				ownSession(child)
			}
			if err := child.Start(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(4)
			}
			fmt.Printf(`{"type":"child","pid":%d}`+"\n", child.Process.Pid)
			continue
		}
		fmt.Printf(`{"type":"stream_event","event":{"delta":%q}}`+"\n", msg.Text)
		fmt.Printf(`{"type":"stream_event","event":{"delta":%q}}`+"\n", "!")
		fmt.Printf(`{"type":"assistant","text":%q}`+"\n", msg.Text+"!")
	}
	os.Exit(0)
}

// TestFakeChildHelper is the child the fake program leaves behind: like
// node under npm's codex.cmd, it reads its input until it closes, and
// marks the file NEXUS_CHAT_MARKER names when it does.
func TestFakeChildHelper(t *testing.T) {
	if os.Getenv("NEXUS_CHAT_CHILD") != "1" {
		return
	}
	time.AfterFunc(30*time.Second, func() { os.Exit(2) })
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = os.WriteFile(os.Getenv("NEXUS_CHAT_MARKER"), nil, 0o644)
	os.Exit(0)
}

// TestFakeSleeperHelper is a command the fake program runs that does not
// end by itself, as a build or a server Claude starts.
func TestFakeSleeperHelper(t *testing.T) {
	if os.Getenv("NEXUS_CHAT_SLEEPER") != "1" {
		return
	}
	if os.Getenv("NEXUS_CHAT_RESIST_TERM") == "1" {
		signal.Ignore(syscall.SIGTERM)
		fmt.Println(`{"type":"resistant-child-ready"}`)
	}
	time.Sleep(time.Minute)
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

// childPid starts a command under the tab's fake program and returns its pid.
func childPid(t *testing.T, service *Service, rec *recorder) int {
	t.Helper()
	if err := send(t, service, "tab", "spawn"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	pid := 0
	rec.waitFor(t, "the command's pid", func(lines []LinePayload, _ []ExitPayload) bool {
		for _, line := range lines {
			var msg struct {
				Type string `json:"type"`
				PID  int    `json:"pid"`
			}
			if line.Dir == DirOut && json.Unmarshal(line.Message, &msg) == nil && msg.Type == "child" {
				pid = msg.PID
				return true
			}
		}
		return false
	})
	return pid
}

func startFake(t *testing.T, service *Service, tabID string, env map[string]string) StartResult {
	t.Helper()
	return startFakeWith(t, service, tabID, env, nil)
}

func startFakeWith(t *testing.T, service *Service, tabID string, env map[string]string, adjust func(*StartParams)) StartResult {
	t.Helper()
	if env == nil {
		env = map[string]string{}
	}
	env["NEXUS_CHAT_FAKE"] = "1"
	start := StartParams{
		WorkspaceID: "ws",
		TabID:       tabID,
		Cwd:         t.TempDir(),
		Program:     os.Args[0],
		Args:        []string{"-test.run=^TestFakeProgramHelper$"},
		Env:         env,
	}
	if adjust != nil {
		adjust(&start)
	}
	params, _ := json.Marshal(start)
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

type testStdin func([]byte) (int, error)

func (w testStdin) WriteContext(_ context.Context, data []byte) (int, error) { return w(data) }
func (w testStdin) Close() error                                             { return nil }

type partialStdin struct {
	closed bool
}

func (p *partialStdin) WriteContext(_ context.Context, data []byte) (int, error) {
	if p.closed {
		return 0, io.ErrClosedPipe
	}
	return len(data) - 1, io.ErrShortWrite
}

func (p *partialStdin) Close() error {
	p.closed = true
	return nil
}

func TestPartialWriteClosesTheUnframedStdin(t *testing.T) {
	service := New()
	sess, err := service.sessionFor(tabKey{workspaceID: "ws", tabID: "tab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	pipe := &partialStdin{}
	sess.proc = &process{stdin: pipe}
	if err := send(t, service, "tab", "partially written"); err == nil {
		t.Fatal("partial write reported success")
	}
	if !pipe.closed {
		t.Fatal("a subsequent message could be written onto the partial JSON line")
	}
}

func TestSendLogsAConfirmedInputBeforeEarlyOutput(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	key := tabKey{workspaceID: "ws", tabID: "tab"}
	sess, err := service.sessionFor(key, "")
	if err != nil {
		t.Fatal(err)
	}
	reading := make(chan struct{})
	unblock := make(chan struct{})
	sess.proc = &process{
		stdin: testStdin(func(data []byte) (int, error) {
			if !bytes.Contains(data, []byte("hello")) {
				return len(data), nil
			}
			// Simulates output the CLI produced before Write returned.
			sess.addOutput(sess.proc, []byte(`{"type":"result"}`))
			close(reading)
			<-unblock
			return len(data), nil
		}),
	}
	sent := make(chan error, 1)
	go func() { sent <- send(t, service, "tab", "hello") }()
	select {
	case <-reading:
	case <-time.After(10 * time.Second):
		t.Fatal("stdout could not be consumed while stdin was writing")
	}
	queued := make(chan error, 1)
	go func() { queued <- send(t, service, "tab", "second") }()
	replay, replayErr := service.Replay(context.Background(), tabParams("tab"))
	close(unblock)
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if err := <-queued; err != nil {
		t.Fatal(err)
	}
	if replayErr != nil || replay.(ReplayResult).LastSeq != 0 {
		t.Fatalf("replay exposed an input still being written: %+v %v", replay, replayErr)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.lines) != 3 || rec.lines[0].Dir != DirIn || rec.lines[1].Dir != DirOut ||
		rec.lines[2].Dir != DirIn || !bytes.Contains(rec.lines[2].Message, []byte("second")) {
		t.Fatalf("want confirmed input followed by its output, got %v", describe(rec.lines))
	}
}

func TestFailedStdinWriteReplaysFailureInsteadOfApproval(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	key := tabKey{workspaceID: "ws", tabID: "tab"}
	sess, err := service.sessionFor(key, "")
	if err != nil {
		t.Fatal(err)
	}
	sess.proc = &process{
		stdin: testStdin(func(_ []byte) (int, error) {
			return 0, io.ErrClosedPipe
		}),
	}
	sess.addOutput(sess.proc, []byte(`{"type":"control_request","request_id":"p","request":{"subtype":"can_use_tool"}}`))
	params := json.RawMessage(`{"workspaceId":"ws","tabId":"tab","message":{"type":"control_response","response":{"request_id":"p"}}}`)
	if _, err := service.Send(context.Background(), params); err == nil {
		t.Fatal("the write succeeded despite the broken pipe")
	}
	rec.reset()
	if _, err := service.Replay(context.Background(), tabParams("tab")); err != nil {
		t.Fatal(err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.lines) != 2 || rec.lines[0].Dir != DirOut || rec.lines[1].Dir != DirSys ||
		!strings.Contains(string(rec.lines[1].Message), `"stdin-failed"`) {
		t.Fatalf("the failed approval was replayed as sent: %v", describe(rec.lines))
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
	result, err := service.Replay(context.Background(), params)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	rec.mu.Lock()
	if len(rec.lines) == 0 || hasOut(rec.lines, `"text":"one!"`) || !hasOut(rec.lines, `"text":"two!"`) {
		rec.mu.Unlock()
		t.Fatalf("replay after %d: %s", mark, describe(rec.lines))
	}
	last := rec.lines[len(rec.lines)-1].Seq
	rec.mu.Unlock()
	if got := result.(ReplayResult).LastSeq; got != last {
		t.Fatalf("lastSeq %d, last replayed %d", got, last)
	}

	// Nothing newer: the answer names the seq the client already has.
	params, _ = json.Marshal(ReplayParams{WorkspaceID: "ws", TabID: "tab", AfterSeq: last + 100})
	result, err = service.Replay(context.Background(), params)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if got := result.(ReplayResult).LastSeq; got != last+100 {
		t.Fatalf("lastSeq after the end = %d, want %d", got, last+100)
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

// A program that exits leaving a child holding its outputs, as npm's
// codex.cmd leaves node, is told as ended, and its input is closed so
// the child, which waits for that, ends too.
func TestExitIsReportedWhenAChildHoldsTheOutputs(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	marker := filepath.Join(t.TempDir(), "input-closed")
	startFake(t, service, "tab", map[string]string{"NEXUS_CHAT_MARKER": marker})
	if err := send(t, service, "tab", "leave"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	rec.waitFor(t, "the exit", func(_ []LinePayload, exits []ExitPayload) bool {
		return len(exits) == 1
	})
	// On Windows the program's job ends the child as the program exits,
	// before its input is closed (TestExitEndsTheCommandsTheProgramLeft).
	if runtime.GOOS != "windows" {
		deadline := time.Now().Add(10 * time.Second)
		for {
			if _, err := os.Stat(marker); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the child's input was never closed")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if restart := startFake(t, service, "tab", nil); restart.Attached {
		t.Fatal("a restart attached to the ended program")
	}
}

func TestStartReportsCanonicalCwdFromAgentHost(t *testing.T) {
	service := New()
	defer service.Close()
	root := t.TempDir()
	target := filepath.Join(root, "project")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Skipf("symlinking a directory: %v", err)
	}
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	start := func() StartResult {
		return startFakeWith(t, service, "tab", nil, func(p *StartParams) {
			p.Cwd = alias
		})
	}
	if got := start(); got.CanonicalCwd != canonical {
		t.Fatalf("start cwd = %q, want %q", got.CanonicalCwd, canonical)
	}
	if got := start(); !got.Attached || got.CanonicalCwd != canonical {
		t.Fatalf("attached result = %+v, want canonical cwd %q", got, canonical)
	}
}

func TestResetLogStartsTheReplayAtTheNewProgram(t *testing.T) {
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
	before := rec.lines[len(rec.lines)-1].Seq
	rec.mu.Unlock()

	startFakeWith(t, service, "tab", nil, func(p *StartParams) {
		p.ResetLog = true
		p.Resumed = true
	})
	rec.reset()
	if _, err := service.Replay(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	rec.mu.Lock()
	lines := rec.lines
	rec.mu.Unlock()
	if len(lines) == 0 {
		t.Fatal("nothing replayed")
	}
	first := lines[0]
	if first.Dir != DirSys || !strings.Contains(string(first.Message), `"resumed":true`) {
		t.Fatalf("first replayed line = %s", describe(lines[:1]))
	}
	if first.Seq <= before {
		t.Fatalf("seq %d did not go on from %d", first.Seq, before)
	}
	if first.At == 0 {
		t.Fatal("line has no time")
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

func TestClosedTabGenerationRejectsLateStart(t *testing.T) {
	service := New()
	defer service.Close()
	closed := json.RawMessage(`{"workspaceId":"ws","tabId":"tab","tabGeneration":"old"}`)
	if _, err := service.CloseTab(context.Background(), closed); err != nil {
		t.Fatal(err)
	}
	start, _ := json.Marshal(map[string]any{
		"workspaceId": "ws", "tabId": "tab", "tabGeneration": "old",
		"cwd": t.TempDir(), "program": os.Args[0],
		"args": []string{"-test.run=^TestFakeProgramHelper$"}, "env": map[string]string{"NEXUS_CHAT_FAKE": "1"},
	})
	if _, err := service.Start(context.Background(), start); err == nil {
		t.Fatal("a start from the closed tab reached the process")
	}
	if service.lookup(tabKey{workspaceID: "ws", tabID: "tab"}) != nil {
		t.Fatal("late start registered a chat session")
	}
}

func TestClosedTabGenerationsStayBounded(t *testing.T) {
	useAttachRoot(t)
	service := New()
	defer service.Close()
	ctx := context.Background()
	const limit = maxClosedTabGenerations
	closeTab := func(tabID, generation string) {
		t.Helper()
		raw, _ := json.Marshal(TabParams{WorkspaceID: "ws", TabID: tabID, TabGeneration: generation})
		if _, err := service.CloseTab(ctx, raw); err != nil {
			t.Fatal(err)
		}
	}
	for i := range limit + 1 {
		closeTab(fmt.Sprintf("tab-%d", i), "first")
	}
	if got := len(service.closedTabs); got > limit {
		t.Fatalf("recorded %d closed tabs, limit %d", got, limit)
	}
	for i := range limit + 1 {
		closeTab("reopened", fmt.Sprintf("generation-%d", i))
	}
	if got := len(service.closedTabs); got > limit {
		t.Fatalf("recorded %d closed generations, limit %d", got, limit)
	}
	if got := service.closedOrder.Len(); got != len(service.closedTabs) {
		t.Fatalf("expiry queue has %d records for %d closed generations", got, len(service.closedTabs))
	}
	key := tabKey{workspaceID: "ws", tabID: "reopened"}
	if _, err := service.sessionFor(key, fmt.Sprintf("generation-%d", limit)); err == nil {
		t.Fatal("the latest closed generation could start")
	}
	if _, err := service.sessionFor(key, "generation-0"); err != nil {
		t.Fatalf("the oldest generation was not evicted: %v", err)
	}
}

func TestClosedTabGenerationsExpire(t *testing.T) {
	service := New()
	key := tabKey{workspaceID: "ws", tabID: "tab"}
	tab := closedTabGeneration{key, "old"}
	service.mu.Lock()
	service.rememberClosedTabLocked(tab, time.Now().Add(-closedTabRetention))
	service.mu.Unlock()
	if _, err := service.sessionFor(key, tab.generation); err != nil {
		t.Fatalf("the expired generation was not removed: %v", err)
	}
	if len(service.closedTabs) != 0 || service.closedOrder.Len() != 0 {
		t.Fatal("the expired generation stayed in the index or expiry queue")
	}
}

func TestStartCannotUseARemovedSession(t *testing.T) {
	for _, closeTab := range []bool{true, false} {
		name := "failed start"
		if closeTab {
			name = "close"
		}
		t.Run(name, func(t *testing.T) {
			service := New()
			defer service.Close()
			key := tabKey{workspaceID: "ws", tabID: "tab"}
			held, err := service.sessionFor(key, "")
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			if closeTab {
				if _, err := service.CloseTab(context.Background(), tabParams("tab")); err != nil {
					t.Fatal(err)
				}
			} else if _, err := service.startSession(held, StartParams{Cwd: dir, Program: filepath.Join(dir, "missing")}, nil); err == nil {
				t.Fatal("the invalid process started")
			}
			if _, err := service.startSession(held, StartParams{
				Cwd: dir, Program: os.Args[0], Args: []string{"-test.run=^TestFakeProgramHelper$"},
			}, mergeEnv(map[string]string{"NEXUS_CHAT_FAKE": "1"})); err == nil {
				t.Fatal("a retained session could start an untracked process")
			}
			startFake(t, service, "tab", nil)
		})
	}
}

func TestStopPublishesExitBeforeReleasingProcess(t *testing.T) {
	service := New()
	defer service.Close()
	exiting := make(chan struct{})
	proceed := make(chan struct{})
	service.SetEventSink(func(event string, _ any) error {
		if event == EventExit {
			close(exiting)
			<-proceed
		}
		return nil
	})
	startFake(t, service, "tab", nil)
	proc := service.lookup(tabKey{workspaceID: "ws", tabID: "tab"}).running()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		_, _ = service.Stop(context.Background(), tabParams("tab"))
	}()
	defer func() {
		close(proceed)
		<-stopped
	}()
	select {
	case <-exiting:
	case <-time.After(10 * time.Second):
		t.Fatal("agent did not emit the exit")
	}
	select {
	case <-proc.done:
		t.Fatal("stop released the process before publishing the exit")
	default:
	}
}

func TestDelayedStdoutCannotBeAttributedToTheReplacement(t *testing.T) {
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	sess, err := service.sessionFor(tabKey{workspaceID: "ws", tabID: "tab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	old := &process{generation: "old"}
	replacement := &process{generation: "current"}
	sess.proc = replacement
	sess.addOutput(old, []byte(`{"type":"result","subtype":"interrupted"}`))
	sess.addOutput(replacement, []byte(`{"type":"result","subtype":"success"}`))
	if len(rec.lines) != 1 || rec.lines[0].ProcessGeneration != "current" ||
		!bytes.Contains(rec.lines[0].Message, []byte("success")) {
		t.Fatalf("a delayed result was attributed to the replacement: %v", describe(rec.lines))
	}
}

func TestAClosedTabsProgramSendsNothingToTheTabsNext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signals")
	}
	// The old program ignores the stop, so it ends only when killed.
	defer func(grace time.Duration) { stopGrace = grace }(stopGrace)
	stopGrace = 100 * time.Millisecond
	service := New()
	rec := newRecorder()
	service.SetEventSink(rec.sink)
	defer service.Close()

	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "linger")
	rec.waitFor(t, "the program to linger", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"lingering"`)
	})
	old := service.lookup(tabKey{workspaceID: "ws", tabID: "tab"}).running()
	if _, err := service.CloseTab(context.Background(), tabParams("tab")); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}
	rec.reset()

	// The tab opens again: a new program in the tab it closed.
	startFake(t, service, "tab", nil)
	_ = send(t, service, "tab", "hello")
	rec.waitFor(t, "the new program's answer", func(lines []LinePayload, _ []ExitPayload) bool {
		return hasOut(lines, `"hello!"`)
	})
	select {
	case <-old.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the closed tab's program did not end")
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.exits) != 0 {
		t.Fatalf("the old program's exit was told: %+v", rec.exits)
	}
	for _, line := range rec.lines {
		if line.Dir == DirSys && strings.Contains(string(line.Message), `"exit"`) {
			t.Fatalf("the old program's exit reached the tab: %s", describe(rec.lines))
		}
	}
	if first := rec.lines[0]; first.Seq != 1 {
		t.Fatalf("the new log starts at %d: %s", first.Seq, describe(rec.lines))
	}
}

// TestCanceledSendDoesNotWaitForEarlierWrites verifies a queued send can
// leave without writing or consuming an input sequence number.
func TestCanceledSendDoesNotWaitForEarlierWrites(t *testing.T) {
	s := New()
	sess, err := s.sessionFor(tabKey{workspaceID: "ws", tabID: "tab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	writes := make(chan struct{}, 1)
	p := &process{stdin: testStdin(func(data []byte) (int, error) {
		writes <- struct{}{}
		return len(data), nil
	})}
	sess.proc = p
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := make(chan error, 1)
	go func() {
		_, err := s.Send(ctx, json.RawMessage(`{"workspaceId":"ws","tabId":"tab","message":{"text":"canceled"}}`))
		result <- err
	}()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) || sess.log.lastSeq() != 0 {
			t.Fatalf("canceled send returned %v with log sequence %d", err, sess.log.lastSeq())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled send waited behind a blocked write")
	}
	select {
	case <-writes:
		t.Fatal("canceled request wrote to the child")
	default:
	}
}

// TestReplayCannotFollowAReplacedConnection changes sinks while the first
// old frame is still being delivered.
func TestReplayCannotFollowAReplacedConnection(t *testing.T) {
	s := New()
	sess, err := s.sessionFor(tabKey{workspaceID: "ws", tabID: "tab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	sess.log.add(DirOut, nil, "one")
	sess.log.add(DirOut, nil, "two")
	oldFrame := make(chan struct{}, 2)
	release := make(chan struct{})
	oldCtx, cancelOld := context.WithCancel(context.Background())
	defer cancelOld()
	s.SetConnectionSink(oldCtx, func(string, any) error {
		oldFrame <- struct{}{}
		<-release
		return nil
	})
	result := make(chan error, 1)
	go func() {
		_, err := s.Replay(oldCtx, tabParams("tab"))
		result <- err
	}()
	select {
	case <-oldFrame:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("old replay did not reach its first frame")
	}
	var fresh []LinePayload
	newCtx, cancelNew := context.WithCancel(context.Background())
	defer cancelNew()
	s.SetConnectionSink(newCtx, func(_ string, payload any) error {
		fresh = append(fresh, payload.(LinePayload))
		return nil
	})
	close(release)
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("old replay returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old replay did not finish after cancellation")
	}
	if len(fresh) != 0 {
		t.Fatalf("new connection got %d old replay frames", len(fresh))
	}
	reply, err := s.Replay(newCtx, tabParams("tab"))
	if err != nil || reply.(ReplayResult).LastSeq != 2 || len(fresh) != 2 || fresh[0].Text != "one" || fresh[1].Text != "two" {
		t.Fatalf("new replay got %+v, %v and %+v", reply, err, fresh)
	}
}

// TestReplayStopsWhenItsConnectionCancels keeps the sink installed while
// canceling the host after its first frame.
func TestReplayStopsWhenItsConnectionCancels(t *testing.T) {
	s := New()
	sess, err := s.sessionFor(tabKey{workspaceID: "ws", tabID: "tab"}, "")
	if err != nil {
		t.Fatal(err)
	}
	sess.log.add(DirOut, nil, "one")
	sess.log.add(DirOut, nil, "two")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	frames := 0
	s.SetConnectionSink(ctx, func(string, any) error {
		frames++
		cancel()
		return nil
	})
	if _, err := s.Replay(ctx, tabParams("tab")); !errors.Is(err, context.Canceled) || frames != 1 {
		t.Fatalf("replay emitted %d frames, returned %v", frames, err)
	}
}

// TestChatStderrTailMasksCredentials checks what exit events and logs will see.
func TestChatStderrTailMasksCredentials(t *testing.T) {
	p := &process{}
	p.readStderr(strings.NewReader("connection to https://example:fake-pass@host.test failed\nAuthorization: Bearer fake-auth\nAPP_SECRET=fake-env\n"))
	got := p.stderr()
	if strings.Contains(got, "fake-") || !strings.Contains(got, "@host.test failed") {
		t.Fatalf("unexpected child diagnostic %q", got)
	}
}
