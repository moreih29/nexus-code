package hookclient

// `agent print-run <claude> [args...]` runs a `claude -p` that a tab's
// Claude session starts, as from its Bash tool or a script it runs, and
// tells the app of it: its start, its end, and between them the tools it
// runs and what it writes, as its stream-json output or else its
// transcript tells them (print_transcript.go). Such a run gets none of the tab's hooks
// (claude-wrapper.sh), and a `--bare` one would run none.
//
// The run is claude's own: its stdin and stderr are claude's, its output
// is passed on as it comes, and its exit is claude's. Telling the app never
// holds the output back: the frames are queued and sent beside it, and
// dropped when the app does not take them.
//
// Once the app knows of the run, the run holds a watch open on the agent's
// socket until its end: a run killed before it can tell its end, as by
// SIGKILL, ends with its process, and the agent tells the app of it then.
// The app answers the watch to stop the run (`nexus agent stop`): claude
// gets the interrupt the session's own ^C would give it.
//
// A run is told with its Claude session id, given it up front when it
// starts a session of its own, so the session that started it can go on
// with it (`claude -p --resume <id>`). A run that goes on a session by its
// id is told as that session's run going on, and its transcript is followed
// from where it was.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// printFramesQueued is how many frames wait to be sent at most; more are dropped.
	printFramesQueued = 256
	// printFrameTimeout is how long one frame may take to be sent and answered.
	printFrameTimeout = 5 * time.Second
	// printEndWait is how long the run's end waits on the frames before it to be sent.
	printEndWait = 3 * time.Second
	// printLineMax is the longest output line read for what it tells; a longer one is passed on unread.
	printLineMax = 8 << 20
	// printTextMax is how long a string of a tool's input, a prompt or an answer may be.
	printTextMax = 2_000
	// printErrorMax is how long a failed tool's error may be.
	printErrorMax = 500
)

// RunPrint is the `agent print-run` entrypoint: args are claude's path and
// its arguments. It returns claude's exit code, and dies of the signal
// claude died of.
func RunPrint(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: agent print-run <claude> [args...]")
		return 2
	}
	teller := newPrintTeller(
		os.Getenv(envAgentSocket),
		os.Getenv(envHookToken),
		os.Getenv(envWorkspaceID),
		os.Getenv(envTabID),
	)
	code, sig := runPrint(args[0], args[1:], os.Stdin, os.Stdout, os.Stderr, teller)
	if sig != 0 {
		reraise(sig)
		return 128 + sig
	}
	return code
}

// printRun is what a `claude -p` run's arguments tell of it.
type printRun struct {
	prompt string
	model  string
	// format is its --output-format: "text", "json" or "stream-json".
	format string
	// sessionID is its session's id, which names its transcript: the one it
	// was given, or the one it goes on.
	sessionID string
	// resumed: it goes on the session sessionID, whose transcript it adds to.
	resumed bool
	// noTranscript: its session is not known, or keeps no transcript here.
	noTranscript bool
}

// sessionFlags are claude's options after which a run keeps no transcript
// of a session here: it runs elsewhere, or keeps none.
var sessionFlags = map[string]bool{
	"--from-pr":                true,
	"--teleport":               true,
	"--cloud":                  true,
	"--bg":                     true,
	"--background":             true,
	"--no-session-persistence": true,
}

// describePrintRun reads a run's arguments. Its prompt is the argument after
// -p, or the first one when it is not an option: claude takes options that
// take more than one value, so a prompt elsewhere is not told apart.
//
// A run that goes on a session goes on its transcript, by `--resume <id>`;
// with `--fork-session` it starts one of its own, as a new run does. One
// that goes on the latest session (`-c`), or one found by a search term,
// goes on a session not known up front.
func describePrintRun(args []string) printRun {
	run := printRun{format: "text", model: os.Getenv("ANTHROPIC_MODEL")}
	var resume string
	var resuming, fork bool
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		run.prompt = args[0]
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if run.prompt == "" && i+1 < len(args) {
				run.prompt = args[i+1]
			}
			break
		}
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch {
		case arg == "-p" || arg == "--print":
			if next != "" && !strings.HasPrefix(next, "-") {
				run.prompt = next
			}
		case arg == "--model" && next != "":
			run.model = next
		case strings.HasPrefix(arg, "--model="):
			run.model = strings.TrimPrefix(arg, "--model=")
		case arg == "--output-format" && next != "":
			run.format = next
		case strings.HasPrefix(arg, "--output-format="):
			run.format = strings.TrimPrefix(arg, "--output-format=")
		case arg == "--session-id" && next != "":
			run.sessionID = next
		case strings.HasPrefix(arg, "--session-id="):
			run.sessionID = strings.TrimPrefix(arg, "--session-id=")
		case arg == "-r" || arg == "--resume":
			resuming = true
			if next != "" && !strings.HasPrefix(next, "-") {
				resume = next
			}
		case strings.HasPrefix(arg, "--resume="):
			resuming, resume = true, strings.TrimPrefix(arg, "--resume=")
		case arg == "-c" || arg == "--continue":
			resuming = true
		case arg == "--fork-session":
			fork = true
		case sessionFlags[strings.SplitN(arg, "=", 2)[0]]:
			run.noTranscript = true
		}
	}
	switch {
	case !resuming || fork:
	case isSessionID(resume):
		run.sessionID, run.resumed = resume, true
	default:
		run.noTranscript = true
	}
	run.prompt = cut(strings.TrimSpace(run.prompt), printTextMax)
	return run
}

// isSessionID is whether s is a session id, as a UUID: `--resume` takes a
// search term as well.
func isSessionID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
				return false
			}
		}
	}
	return true
}

// runPrint runs claude and tells `teller` of the run. It returns claude's
// exit code, or the signal it died of.
func runPrint(
	claude string,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	teller *printTeller,
) (code int, sig int) {
	run := describePrintRun(args)
	// A run that starts a session of its own is given its id, unless it has
	// one: the run is told by it, and its transcript named.
	if teller != nil && !run.noTranscript && run.sessionID == "" {
		if run.sessionID = newSessionID(); run.sessionID != "" {
			args = append([]string{"--session-id", run.sessionID}, args...)
		}
	}
	// A run whose output does not tell its tools tells them in its
	// transcript; one that goes on a session, from where the session was.
	var transcript *printTranscript
	if teller != nil && run.format != "stream-json" && !run.noTranscript && run.sessionID != "" {
		transcript = newPrintTranscript(run.sessionID)
		if transcript != nil && run.resumed {
			transcript.startAtEnd()
		}
	}
	cmd := exec.Command(claude, args...)
	cmd.Stdin = stdin
	cmd.Stderr = stderr
	// A json or stream-json run's output tells of the run, and a text run's
	// is its answer. A terminal stays claude's own: claude prints to it as a
	// terminal, and its answer is then its transcript's.
	text := run.format != "stream-json" && run.format != "json"
	var out io.ReadCloser
	if teller != nil && (!text || !isTerminal(stdout)) {
		pipe, err := cmd.StdoutPipe()
		if err != nil {
			fmt.Fprintf(stderr, "nexus: %v\n", err)
			return 127, 0
		}
		out = pipe
	} else {
		cmd.Stdout = stdout
	}

	proc, ok := startSupervised(cmd, teller, stderr)
	if !ok {
		return 127, 0
	}
	defer proc.release()

	cwd, _ := os.Getwd()
	start := map[string]any{
		"prompt":     run.prompt,
		"model":      run.model,
		"cwd":        cwd,
		"tools_told": run.format == "stream-json",
	}
	if run.sessionID != "" {
		start["session_id"] = run.sessionID
	}
	if run.resumed {
		start["resumed"] = true
	}
	if endpoint := endpointHost(os.Getenv("ANTHROPIC_BASE_URL"), "api.anthropic.com"); endpoint != "" {
		start["endpoint"] = endpoint
	}
	teller.tell("print-start", start)
	known := run.prompt != ""
	watch := &printWatch{tell: teller.tell, text: text, promptTold: known}
	var told *printWatch
	if transcript != nil {
		told = &printWatch{tell: teller.tell, promptTold: known}
		go transcript.follow(told, func() {
			teller.tell("print-init", map[string]any{"tools_told": true})
		})
	}
	if out != nil {
		passOutput(out, stdout, watch.line)
		// Output no one reads any more: claude finds its pipe closed, as it
		// would writing to it alone.
		_ = out.Close()
	}
	_ = cmd.Wait()
	answer := watch.answer
	if transcript != nil && transcript.end(printEndWait) && answer == "" {
		answer = told.reply
	}

	code, sig, end := proc.ending()
	if answer != "" {
		end["answer"] = answer
	}
	teller.finish("print-end", end, printEndWait)
	return code, sig
}

// supervised is a run's process, started with the signals the run gets
// passed on to it and the app's stop wired to it.
type supervised struct {
	cmd *exec.Cmd
	// stopped is the first signal the run got: the program may end by it
	// with an exit code of its own.
	stopped chan os.Signal
	release func()
}

// startSupervised starts cmd: the signals the run gets reach it, and the
// app stops it as the session's ^C would. False when it could not start,
// which is told on stderr. release, deferred, stops taking the signals.
func startSupervised(cmd *exec.Cmd, teller *printTeller, stderr io.Writer) (*supervised, bool) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, forwardedSignals...)
	// A write to output no one reads fails rather than kill the run's end.
	// (Notify with no signals would take them all.)
	var quiet chan os.Signal
	if len(swallowedSignals) > 0 {
		quiet = make(chan os.Signal, 1)
		signal.Notify(quiet, swallowedSignals...)
	}
	release := func() {
		signal.Stop(signals)
		if quiet != nil {
			signal.Stop(quiet)
		}
	}
	if err := cmd.Start(); err != nil {
		release()
		fmt.Fprintf(stderr, "nexus: %v\n", err)
		return nil, false
	}
	stopped := make(chan os.Signal, 1)
	go func() {
		for s := range signals {
			select {
			case stopped <- s:
			default:
			}
			_ = cmd.Process.Signal(s)
		}
	}()
	teller.onStop(func() {
		if s := stopProcess(cmd.Process); s != nil {
			select {
			case stopped <- s:
			default:
			}
		}
	})
	return &supervised{cmd: cmd, stopped: stopped, release: release}, true
}

// ending is how the run's process ended, once waited for: its exit code,
// or the signal it died of, and the end frame's payload telling it.
func (p *supervised) ending() (code int, sig int, end map[string]any) {
	code = p.cmd.ProcessState.ExitCode()
	end = map[string]any{}
	if n, name, ok := signalOf(p.cmd.ProcessState); ok {
		sig = n
		end["signal"] = name
		return code, sig, end
	}
	end["exit_code"] = code
	// Stopped by the app: the program may exit 0 on an interrupt, as claude
	// does printing "Execution error" as its answer.
	select {
	case s := <-p.stopped:
		end["signal"] = s.String()
	default:
	}
	return code, sig, end
}

// passOutput copies r to w as it comes, and hands each line to `line`
// (without its newline, to be read before it returns). A failed write ends
// it.
func passOutput(r io.Reader, w io.Writer, line func([]byte)) {
	buf := make([]byte, 64<<10)
	lines := lineSplitter{line: line}
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			lines.feed(buf[:n])
		}
		if err != nil {
			lines.flush()
			return
		}
	}
}

// lineSplitter hands each line of what it is fed to `line`, without its
// newline, to be read before it returns; a line longer than printLineMax is
// skipped.
type lineSplitter struct {
	line     func([]byte)
	pending  []byte
	skipping bool
}

func (s *lineSplitter) feed(chunk []byte) {
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			if !s.skipping {
				s.pending = append(s.pending, chunk...)
				if len(s.pending) > printLineMax {
					s.pending, s.skipping = s.pending[:0], true
				}
			}
			return
		}
		if !s.skipping {
			s.pending = append(s.pending, chunk[:i]...)
			s.line(s.pending)
		}
		s.pending, s.skipping = s.pending[:0], false
		chunk = chunk[i+1:]
	}
}

// flush hands on the last line, which no newline ended.
func (s *lineSplitter) flush() {
	if len(s.pending) > 0 && !s.skipping {
		s.line(s.pending)
	}
	s.pending, s.skipping = s.pending[:0], false
}

// printWatch reads a run's output, or its transcript, for what it tells:
// claude's start (its model), the tools it runs and how they end, what it
// writes between them, and its answer.
type printWatch struct {
	tell func(subcommand string, payload map[string]any)
	// text: the output is the answer itself, as claude prints it in text.
	text   bool
	answer string
	// reply is what claude wrote since its last tool's result: its answer,
	// once the run is over, as a transcript tells it.
	reply     string
	modelTold bool
	// promptTold: the run's prompt is known, from its arguments or the
	// user's message claude first answers; one given on stdin, or after
	// other options than -p, is told from there.
	promptTold bool
	// answering: claude has begun to answer, so a user's message is no
	// longer the prompt.
	answering bool
}

type printEvent struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	Model     string          `json:"model"`
	Cwd       string          `json:"cwd"`
	SessionID string          `json:"session_id"`
	IsMeta    bool            `json:"isMeta"`
	Result    json.RawMessage `json:"result"`
	Message   struct {
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type printBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (w *printWatch) line(b []byte) {
	if w.text {
		if utf8.RuneCountInString(w.answer) <= printTextMax {
			w.answer = cut(strings.TrimSpace(w.answer+"\n"+string(b)), printTextMax)
		}
		return
	}
	b = bytes.TrimSpace(b)
	if len(b) == 0 || b[0] != '{' {
		return
	}
	var event printEvent
	if json.Unmarshal(b, &event) != nil {
		return
	}
	switch event.Type {
	case "system":
		if event.Subtype == "init" {
			w.modelTold = true
			init := map[string]any{"model": event.Model, "cwd": event.Cwd}
			if event.SessionID != "" {
				init["session_id"] = event.SessionID
			}
			w.tell("print-init", init)
		}
	case "assistant":
		w.answering = true
		// A transcript tells no init: its model is its first message's
		// (not one Claude Code makes up, as "<synthetic>").
		if model := event.Message.Model; !w.modelTold && model != "" && !strings.HasPrefix(model, "<") {
			w.modelTold = true
			init := map[string]any{"model": model}
			if event.Cwd != "" {
				init["cwd"] = event.Cwd
			}
			w.tell("print-init", init)
		}
		for _, block := range blocksOf(event.Message.Content) {
			switch {
			case block.Type == "tool_use" && block.Name != "":
				w.tell("print-tool-use", map[string]any{
					"tool_use_id": block.ID,
					"tool_name":   block.Name,
					"tool_input":  trimInput(block.Input),
				})
			case block.Type == "text":
				said := strings.TrimSpace(block.Text)
				if said == "" {
					continue
				}
				// Not a message Claude Code makes up (its model "<synthetic>").
				if !strings.HasPrefix(event.Message.Model, "<") {
					w.tell("print-text", map[string]any{"text": cut(said, printTextMax)})
				}
				if utf8.RuneCountInString(w.reply) <= printTextMax {
					w.reply = cut(strings.TrimSpace(w.reply+"\n"+said), printTextMax)
				}
			}
		}
	case "user":
		w.reply = ""
		if !w.promptTold && !w.answering && !event.IsMeta {
			if prompt := strings.TrimSpace(textOf(event.Message.Content)); prompt != "" {
				w.promptTold = true
				w.tell("print-init", map[string]any{"prompt": cut(prompt, printTextMax)})
			}
		}
		for _, block := range blocksOf(event.Message.Content) {
			if block.Type != "tool_result" || block.ToolUseID == "" {
				continue
			}
			result := map[string]any{"tool_use_id": block.ToolUseID, "is_error": block.IsError}
			if block.IsError {
				result["error"] = cut(textOf(block.Content), printErrorMax)
			}
			w.tell("print-tool-result", result)
		}
	case "result":
		var answer string
		if json.Unmarshal(event.Result, &answer) == nil {
			w.answer = cut(strings.TrimSpace(answer), printTextMax)
		}
	}
}

// blocksOf is a message's content blocks; none for a content that is text.
func blocksOf(content json.RawMessage) []printBlock {
	var blocks []printBlock
	if json.Unmarshal(content, &blocks) != nil {
		return nil
	}
	return blocks
}

// textOf is a tool result's text: the content itself, or its text blocks.
func textOf(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part.Type == "text" {
			texts = append(texts, part.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// trimInput is a tool's input with its long strings cut, as a file's
// content to write: the app shows what a tool works on, not all it carries.
func trimInput(input json.RawMessage) any {
	var fields map[string]any
	if json.Unmarshal(input, &fields) != nil {
		return map[string]any{}
	}
	for key, value := range fields {
		if s, ok := value.(string); ok {
			fields[key] = cut(s, printTextMax)
		}
	}
	return fields
}

// endpointHost is the host a base URL names, as "gw.example.com:8443",
// when it is not `home`, the program's own API: a run whose model is served
// elsewhere tells where. Nothing else of the URL is told, as a key in it.
func endpointHost(base, home string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || strings.EqualFold(u.Hostname(), home) {
		return ""
	}
	return u.Host
}

// isTerminal is whether w is a terminal.
func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// cut is s to at most max characters.
func cut(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}

// printTeller sends a run's frames to the agent's hook socket, in order and
// beside the run. A nil teller tells nothing: the run is outside the app.
type printTeller struct {
	socket, token, workspaceID, tabID string
	runID                             string
	frames                            chan printFrame
	done                              chan struct{}

	mu sync.Mutex
	// watch is the run's watch, open from its start until its end.
	watch net.Conn
	ended bool
	// stop stops the run, when the app answers its watch so.
	stop func()

	// queue guards frames: a transcript followed beside the run may tell
	// of it after its end.
	queue  sync.Mutex
	queued bool
}

type printFrame struct {
	subcommand string
	payload    map[string]any
}

// newPrintTeller is a teller for the app's agent at `socket`; nil when the
// run has no app to tell.
func newPrintTeller(socket, token, workspaceID, tabID string) *printTeller {
	if socket == "" || token == "" || workspaceID == "" || tabID == "" {
		return nil
	}
	var id [8]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil
	}
	t := &printTeller{
		socket:      socket,
		token:       token,
		workspaceID: workspaceID,
		tabID:       tabID,
		runID:       "print-" + hex.EncodeToString(id[:]),
		frames:      make(chan printFrame, printFramesQueued),
		done:        make(chan struct{}),
	}
	go t.send()
	return t
}

// tell queues a frame, or drops it when too many wait or the run's end is
// told.
func (t *printTeller) tell(subcommand string, payload map[string]any) {
	if t == nil {
		return
	}
	payload["run_id"] = t.runID
	t.queue.Lock()
	defer t.queue.Unlock()
	if t.queued {
		return
	}
	select {
	case t.frames <- printFrame{subcommand, payload}:
	default:
	}
}

// finish queues the run's last frame and waits up to `wait` for the frames
// to be sent, then closes the run's watch.
func (t *printTeller) finish(subcommand string, payload map[string]any, wait time.Duration) {
	if t == nil {
		return
	}
	defer t.closeWatch()
	payload["run_id"] = t.runID
	timer := time.NewTimer(wait)
	defer timer.Stop()
	t.queue.Lock()
	t.queued = true
	select {
	case t.frames <- printFrame{subcommand, payload}:
		close(t.frames)
		t.queue.Unlock()
	case <-timer.C:
		t.queue.Unlock()
		return
	}
	select {
	case <-t.done:
	case <-timer.C:
	}
}

func (t *printTeller) send() {
	defer close(t.done)
	broken := false
	for frame := range t.frames {
		// An agent that is not there will not be the next time either.
		if broken {
			continue
		}
		broken = !t.deliver(frame)
		if !broken && frame.subcommand == "print-start" {
			t.openWatch()
		}
	}
}

// openWatch opens the run's watch, once the app knows of the run: a hook
// the agent holds open with no answer until its connection closes, which it
// then tells the app of. The run closes it at its end, after telling it;
// a run killed first closes it as its process ends.
func (t *printTeller) openWatch() {
	conn, err := net.DialTimeout("unix", t.socket, printFrameTimeout)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]string{"run_id": t.runID})
	_ = conn.SetDeadline(time.Now().Add(printFrameTimeout))
	err = writeNDJSON(conn, hookRequest{
		Type:        "hook",
		Token:       t.token,
		WorkspaceID: t.workspaceID,
		TabID:       t.tabID,
		Subcommand:  "print-watch",
		Payload:     payload,
	})
	_ = conn.SetDeadline(time.Time{})
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil || t.ended {
		conn.Close()
		return
	}
	t.watch = conn
	go t.awaitStop(conn)
}

// printStopAnswer is how the app answers a run's watch to stop the run; any
// other answer, as the agent's when the app goes, leaves it be.
const printStopAnswer = "stop"

// onStop sets what stops the run when the app asks.
func (t *printTeller) onStop(stop func()) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stop = stop
}

// awaitStop reads the app's answer to the run's watch, which it gives only
// to stop the run.
func (t *printTeller) awaitStop(conn net.Conn) {
	resp, err := readNDJSON(conn)
	if err != nil || resp.Stdout != printStopAnswer {
		return
	}
	t.mu.Lock()
	stop := t.stop
	ended := t.ended
	t.mu.Unlock()
	if stop != nil && !ended {
		stop()
	}
}

// closeWatch closes the run's watch, and keeps one from opening after.
func (t *printTeller) closeWatch() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ended = true
	if t.watch != nil {
		t.watch.Close()
		t.watch = nil
	}
}

// deliver sends one frame as a hook and waits on its answer; false when the
// agent could not be reached.
func (t *printTeller) deliver(frame printFrame) bool {
	payload, err := json.Marshal(frame.payload)
	if err != nil {
		return true
	}
	conn, err := net.DialTimeout("unix", t.socket, printFrameTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(printFrameTimeout))
	req := hookRequest{
		Type:        "hook",
		Token:       t.token,
		WorkspaceID: t.workspaceID,
		TabID:       t.tabID,
		Subcommand:  frame.subcommand,
		Payload:     payload,
	}
	if writeNDJSON(conn, req) != nil {
		return true
	}
	_, _ = readNDJSON(conn)
	return true
}
