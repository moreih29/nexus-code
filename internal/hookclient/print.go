package hookclient

// `agent print-run <claude> [args...]` runs a `claude -p` that a tab's
// Claude session starts, as from its Bash tool or a script it runs, and
// tells the app of it: its start, its end, and between them the tools it
// runs, as its stream-json output tells them. Such a run gets none of the
// tab's hooks (claude-wrapper.sh), and a `--bare` one would run none.
//
// The run is claude's own: its stdin and stderr are claude's, its output
// is passed on as it comes, and its exit is claude's. Telling the app never
// holds the output back: the frames are queued and sent beside it, and
// dropped when the app does not take them.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strings"
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
}

// describePrintRun reads a run's arguments. Its prompt is the argument after
// -p, or the first one when it is not an option: claude takes options that
// take more than one value, so a prompt elsewhere is not told apart.
func describePrintRun(args []string) printRun {
	run := printRun{format: "text", model: os.Getenv("ANTHROPIC_MODEL")}
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
		}
	}
	run.prompt = cut(strings.TrimSpace(run.prompt), printTextMax)
	return run
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
	cmd := exec.Command(claude, args...)
	cmd.Stdin = stdin
	cmd.Stderr = stderr
	// A json or stream-json run's output tells of the run, and a text run's
	// is its answer. A terminal stays claude's own: claude prints to it as a
	// terminal, and its answer is the user's to read there.
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

	signals := make(chan os.Signal, 4)
	signal.Notify(signals, forwardedSignals...)
	defer signal.Stop(signals)
	// A write to output no one reads fails rather than kill the run's end.
	// (Notify with no signals would take them all.)
	if len(swallowedSignals) > 0 {
		quiet := make(chan os.Signal, 1)
		signal.Notify(quiet, swallowedSignals...)
		defer signal.Stop(quiet)
	}

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "nexus: %v\n", err)
		return 127, 0
	}
	// The first signal the run got: claude may end by it with an exit code
	// of its own.
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

	cwd, _ := os.Getwd()
	teller.tell("print-start", map[string]any{
		"prompt":     run.prompt,
		"model":      run.model,
		"cwd":        cwd,
		"tools_told": run.format == "stream-json",
	})
	watch := &printWatch{tell: teller.tell, text: text}
	if out != nil {
		passOutput(out, stdout, watch.line)
		// Output no one reads any more: claude finds its pipe closed, as it
		// would writing to it alone.
		_ = out.Close()
	}
	_ = cmd.Wait()

	code = cmd.ProcessState.ExitCode()
	end := map[string]any{}
	if n, name, ok := signalOf(cmd.ProcessState); ok {
		sig = n
		end["signal"] = name
	} else {
		end["exit_code"] = code
		select {
		case s := <-stopped:
			if code != 0 {
				end["signal"] = s.String()
			}
		default:
		}
	}
	if watch.answer != "" {
		end["answer"] = watch.answer
	}
	teller.finish("print-end", end, printEndWait)
	return code, sig
}

// passOutput copies r to w as it comes, and hands each line to `line`
// (without its newline, to be read before it returns). A failed write ends
// it.
func passOutput(r io.Reader, w io.Writer, line func([]byte)) {
	buf := make([]byte, 64<<10)
	var pending []byte
	skipping := false
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			chunk := buf[:n]
			for len(chunk) > 0 {
				i := bytes.IndexByte(chunk, '\n')
				if i < 0 {
					if !skipping {
						pending = append(pending, chunk...)
						if len(pending) > printLineMax {
							pending, skipping = pending[:0], true
						}
					}
					break
				}
				if !skipping {
					pending = append(pending, chunk[:i]...)
					line(pending)
				}
				pending, skipping = pending[:0], false
				chunk = chunk[i+1:]
			}
		}
		if err != nil {
			if len(pending) > 0 && !skipping {
				line(pending)
			}
			return
		}
	}
}

// printWatch reads a run's output for what it tells: claude's start (its
// model), the tools it runs and how they end, and its answer.
type printWatch struct {
	tell func(subcommand string, payload map[string]any)
	// text: the output is the answer itself, as claude prints it in text.
	text   bool
	answer string
}

type printEvent struct {
	Type    string          `json:"type"`
	Subtype string          `json:"subtype"`
	Model   string          `json:"model"`
	Cwd     string          `json:"cwd"`
	Result  json.RawMessage `json:"result"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type printBlock struct {
	Type      string          `json:"type"`
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
			w.tell("print-init", map[string]any{"model": event.Model, "cwd": event.Cwd})
		}
	case "assistant":
		for _, block := range blocksOf(event.Message.Content) {
			if block.Type == "tool_use" && block.Name != "" {
				w.tell("print-tool-use", map[string]any{
					"tool_use_id": block.ID,
					"tool_name":   block.Name,
					"tool_input":  trimInput(block.Input),
				})
			}
		}
	case "user":
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

// tell queues a frame, or drops it when too many wait.
func (t *printTeller) tell(subcommand string, payload map[string]any) {
	if t == nil {
		return
	}
	payload["run_id"] = t.runID
	select {
	case t.frames <- printFrame{subcommand, payload}:
	default:
	}
}

// finish queues the run's last frame and waits up to `wait` for the frames
// to be sent.
func (t *printTeller) finish(subcommand string, payload map[string]any, wait time.Duration) {
	if t == nil {
		return
	}
	payload["run_id"] = t.runID
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case t.frames <- printFrame{subcommand, payload}:
	case <-timer.C:
		return
	}
	close(t.frames)
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
