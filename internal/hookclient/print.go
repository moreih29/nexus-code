package hookclient

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

	"github.com/nexus-code/nexus-code/internal/nodeshim"
)

const (
	printFramesQueued = 256
	printFrameTimeout = 5 * time.Second
	printEndWait      = 3 * time.Second
	printLineMax      = 8 << 20
	printTextMax      = 2_000
	printErrorMax     = 500
)

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

type printRun struct {
	prompt       string
	model        string
	format       string
	sessionID    string
	resumed      bool
	noTranscript bool
}

var sessionFlags = map[string]bool{
	"--from-pr":                true,
	"--teleport":               true,
	"--cloud":                  true,
	"--bg":                     true,
	"--background":             true,
	"--no-session-persistence": true,
}

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

func runPrint(
	claude string,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	teller *printTeller,
) (code int, sig int) {
	run := describePrintRun(args)
	if teller != nil && !run.noTranscript && run.sessionID == "" {
		if run.sessionID = newSessionID(); run.sessionID != "" {
			args = append([]string{"--session-id", run.sessionID}, args...)
		}
	}
	var transcript *printTranscript
	if teller != nil && run.format != "stream-json" && !run.noTranscript && run.sessionID != "" {
		transcript = newPrintTranscript(run.sessionID)
		if transcript != nil && run.resumed {
			transcript.startAtEnd()
		}
	}
	cmd := nodeshim.Command(claude, args...)
	releaseChild, err := preparePrintChild(cmd)
	if err != nil {
		fmt.Fprintf(stderr, "nexus: %v\n", err)
		return 127, 0
	}
	defer releaseChild()
	cmd.Stdin = stdin
	cmd.Stderr = stderr
	text := run.format != "stream-json" && run.format != "json"
	var out *printOutput
	if teller != nil && (!text || !isTerminal(stdout)) {
		pipe, err := capturePrintOutput(&cmd.Stdout)
		if err != nil {
			fmt.Fprintf(stderr, "nexus: %v\n", err)
			return 127, 0
		}
		out = pipe
		defer out.close()
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
	if !run.noTranscript && run.sessionID != "" {
		if home := absoluteDir(claudeConfigDir()); home != "" {
			start["home"] = home
		}
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
	var readers sync.WaitGroup
	out.start(&readers, stdout, watch.line)
	waitPrint(cmd, &readers, out)
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

type supervised struct {
	cmd     *exec.Cmd
	stopped chan os.Signal
	release func()
}

func startSupervised(cmd *exec.Cmd, teller *printTeller, stderr io.Writer) (*supervised, bool) {
	var signals chan os.Signal
	if taken := notIgnored(forwardedSignals); len(taken) > 0 {
		signals = make(chan os.Signal, 4)
		signal.Notify(signals, taken...)
	}
	var quiet chan os.Signal
	if taken := notIgnored(swallowedSignals); len(taken) > 0 {
		quiet = make(chan os.Signal, 1)
		signal.Notify(quiet, taken...)
	}
	release := func() {
		if signals != nil {
			signal.Stop(signals)
		}
		if quiet != nil {
			signal.Stop(quiet)
		}
	}
	cmd.WaitDelay = printOutputGrace
	if err := cmd.Start(); err != nil {
		release()
		fmt.Fprintf(stderr, "nexus: %v\n", err)
		return nil, false
	}
	tree := holdTree(cmd.Process)
	stopped := make(chan os.Signal, 1)
	if signals != nil {
		go func() {
			for s := range signals {
				select {
				case stopped <- s:
				default:
				}
				_ = cmd.Process.Signal(s)
			}
		}()
	}
	teller.onStop(func() {
		if s := stopProcess(cmd.Process, tree); s != nil {
			select {
			case stopped <- s:
			default:
			}
		}
	})
	return &supervised{cmd: cmd, stopped: stopped, release: func() {
		release()
		tree.release()
	}}, true
}

func notIgnored(sigs []os.Signal) []os.Signal {
	var taken []os.Signal
	for _, sig := range sigs {
		if !signal.Ignored(sig) {
			taken = append(taken, sig)
		}
	}
	return taken
}

func (p *supervised) ending() (code int, sig int, end map[string]any) {
	code = p.cmd.ProcessState.ExitCode()
	end = map[string]any{}
	if n, name, ok := signalOf(p.cmd.ProcessState); ok {
		sig = n
		end["signal"] = name
		return code, sig, end
	}
	end["exit_code"] = code
	select {
	case s := <-p.stopped:
		end["signal"] = s.String()
	default:
	}
	return code, sig, end
}

const printOutputGrace = 500 * time.Millisecond

type printOutput struct {
	reader *os.File
	writer *os.File
}

func capturePrintOutput(output *io.Writer) (*printOutput, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	*output = writer
	return &printOutput{reader: reader, writer: writer}, nil
}

func (p *printOutput) start(readers *sync.WaitGroup, dst io.Writer, line func([]byte)) {
	if p == nil {
		return
	}
	_ = p.writer.Close()
	readers.Add(1)
	go func() {
		defer readers.Done()
		defer p.reader.Close()
		passOutput(p.reader, dst, line)
	}()
}

func (p *printOutput) close() {
	if p != nil {
		_ = p.writer.Close()
		_ = p.reader.Close()
	}
}

func waitPrint(cmd *exec.Cmd, readers *sync.WaitGroup, outputs ...*printOutput) {
	_ = cmd.Wait()
	drained := make(chan struct{})
	go func() {
		readers.Wait()
		close(drained)
	}()
	timer := time.NewTimer(printOutputGrace)
	defer timer.Stop()
	select {
	case <-drained:
	case <-timer.C:
		for _, output := range outputs {
			output.close()
		}
		<-drained
	}
}

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

func (s *lineSplitter) flush() {
	if len(s.pending) > 0 && !s.skipping {
		s.line(s.pending)
	}
	s.pending, s.skipping = s.pending[:0], false
}

type printWatch struct {
	tell       func(subcommand string, payload map[string]any)
	text       bool
	answer     string
	reply      string
	modelTold  bool
	promptTold bool
	answering  bool
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

func blocksOf(content json.RawMessage) []printBlock {
	var blocks []printBlock
	if json.Unmarshal(content, &blocks) != nil {
		return nil
	}
	return blocks
}

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

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func cut(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}

type printTeller struct {
	socket, token, workspaceID, tabID string
	runID                             string
	frames                            chan printFrame
	done                              chan struct{}

	mu    sync.Mutex
	watch net.Conn
	ended bool
	stop  func()

	queue  sync.Mutex
	queued bool
}

type printFrame struct {
	subcommand string
	payload    map[string]any
}

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
		if broken {
			continue
		}
		broken = !t.deliver(frame)
		if !broken && frame.subcommand == "print-start" {
			t.openWatch()
		}
	}
}

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

const printStopAnswer = "stop"

func (t *printTeller) onStop(stop func()) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stop = stop
}

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

func (t *printTeller) closeWatch() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ended = true
	if t.watch != nil {
		t.watch.Close()
		t.watch = nil
	}
}

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
