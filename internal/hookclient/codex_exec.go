package hookclient

// `agent exec-run <codex> [args...]` runs a `codex exec` that a tab's Claude
// session starts, as from its Bash tool or a script it runs, and tells the
// app of it as print-run tells a `claude -p` run (print.go): the same
// frames, the run told as codex's, so that it is one of the session's
// agents beside its subagents and `claude -p` runs.
//
// A run that prints events (`--json`) tells its tools and answer from them.
// Its session is told unless it keeps none (--ephemeral): `codex exec
// resume <id>` goes on with it, and is told as the same run going on.
// One that prints text tells its model, provider and session from the
// header codex writes on stderr, and its answer is its output; its tools
// are not told. A prompt codex reads from stdin is read as it passes, and
// told.
//
// The run is codex's own: its input, output and exit are codex's.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// RunCodexExec is the `agent exec-run` entrypoint: args are codex's path and
// its arguments. It returns codex's exit code, and dies of the signal codex
// died of.
func RunCodexExec(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: agent exec-run <codex> [args...]")
		return 2
	}
	teller := newPrintTeller(
		os.Getenv(envAgentSocket),
		os.Getenv(envHookToken),
		os.Getenv(envWorkspaceID),
		os.Getenv(envTabID),
	)
	code, sig := runCodexExec(args[0], args[1:], os.Stdin, os.Stdout, os.Stderr, teller)
	if sig != 0 {
		reraise(sig)
		return 128 + sig
	}
	return code
}

// codexRun is what a `codex exec` run's arguments tell of it.
type codexRun struct {
	// exec: the arguments run `codex exec`, rather than its help or another command.
	exec   bool
	prompt string
	// stdinPrompt: codex reads its prompt from stdin.
	stdinPrompt bool
	model       string
	provider    string
	profile     string
	// events: it prints its events as JSON lines (--json).
	events bool
	// sessionID is the session it goes on (`codex exec resume <id>`).
	sessionID string
	resumed   bool
	// noConfig: it does not read the user's config.toml.
	noConfig bool
	// ephemeral: it keeps no session to go on with (--ephemeral).
	ephemeral bool
	// baseURLs is where each provider codex's config defines serves.
	baseURLs map[string]string
}

// codexValueOptions are codex's options that take a value, given as the
// next argument or after "=".
var codexValueOptions = map[string]bool{
	"-c": true, "--config": true, "--enable": true, "--disable": true,
	"--remote": true, "--remote-auth-token-env": true,
	"-i": true, "--image": true, "-m": true, "--model": true,
	"--local-provider": true, "-p": true, "--profile": true,
	"-s": true, "--sandbox": true, "-C": true, "--cd": true,
	"--add-dir": true, "-a": true, "--ask-for-approval": true,
	"--thread-source": true, "--cyber-access-program": true,
	"--output-schema": true, "--color": true,
	"-o": true, "--output-last-message": true,
}

// describeCodexExec reads a run's arguments: codex's options, the `exec`
// command (or `e`), and its prompt, or the session it resumes and the
// prompt after it.
func describeCodexExec(args []string) codexRun {
	var run codexRun
	var positional []string
	last := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			// No command after it: it is the prompt.
			if len(positional) == 0 {
				return codexRun{}
			}
			positional = append(positional, args[i+1:]...)
			break
		}
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		name, value, inline := strings.Cut(arg, "=")
		if !inline && codexValueOptions[name] && i+1 < len(args) {
			i++
			value = args[i]
		}
		switch name {
		case "-h", "--help", "-V", "--version":
			return codexRun{}
		case "-m", "--model":
			run.model = value
		case "-p", "--profile":
			run.profile = value
		case "-c", "--config":
			key, setting, ok := strings.Cut(value, "=")
			switch strings.TrimSpace(key) {
			case "model":
				if ok {
					run.model = tomlString(setting)
				}
			case "model_provider":
				if ok {
					run.provider = tomlString(setting)
				}
			}
		case "--oss":
			if run.provider == "" {
				run.provider = "oss"
			}
		case "--local-provider":
			run.provider = value
		case "--json", "--experimental-json":
			run.events = true
		case "--ignore-user-config":
			run.noConfig = true
		case "--ephemeral":
			run.ephemeral = true
		case "--last":
			last = true
		}
	}
	if len(positional) == 0 || (positional[0] != "exec" && positional[0] != "e") {
		return codexRun{}
	}
	rest := positional[1:]
	if len(rest) > 0 {
		switch rest[0] {
		case "help":
			return codexRun{}
		case "resume":
			run.resumed = true
			rest = rest[1:]
			if !last && len(rest) > 0 {
				// An id, or a thread's name, which names no session told.
				if isSessionID(rest[0]) {
					run.sessionID = rest[0]
				}
				rest = rest[1:]
			}
		case "fork":
			rest = rest[1:]
			if len(rest) > 0 {
				rest = rest[1:]
			}
		case "review":
			run.exec = true
			run.prompt = "review"
			return run
		}
	}
	run.exec = true
	if len(rest) == 0 || rest[0] == "-" {
		run.stdinPrompt = true
	} else {
		run.prompt = cut(strings.TrimSpace(rest[0]), printTextMax)
	}
	return run
}

// tomlString is a TOML value as the string it is: a quoted one's content,
// or a bare one up to a comment.
func tomlString(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	switch value[0] {
	case '"':
		for i := 1; i < len(value); i++ {
			switch value[i] {
			case '\\':
				i++
			case '"':
				var s string
				if json.Unmarshal([]byte(value[:i+1]), &s) == nil {
					return s
				}
				return value[1:i]
			}
		}
		return strings.Trim(value, `"`)
	case '\'':
		if end := strings.IndexByte(value[1:], '\''); end >= 0 {
			return value[1 : end+1]
		}
		return strings.Trim(value, "'")
	}
	if i := strings.IndexByte(value, '#'); i >= 0 {
		value = value[:i]
	}
	return strings.TrimSpace(value)
}

// codexSettings is what codex's config says of a run's model: the model,
// its provider, and where each provider it defines serves.
type codexSettings struct {
	model, provider string
	baseURLs        map[string]string
}

// readCodexConfig reads a codex config file's model, provider and the
// providers' base URLs into `into`; a file it cannot read changes nothing.
func readCodexConfig(path string, into *codexSettings) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	table := ""
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '[' {
			table = strings.TrimSpace(strings.Trim(line, "[]"))
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		switch {
		case table == "" && key == "model":
			into.model = tomlString(value)
		case table == "" && key == "model_provider":
			into.provider = tomlString(value)
		case strings.HasPrefix(table, "model_providers.") && key == "base_url":
			id := strings.Trim(strings.TrimPrefix(table, "model_providers."), `"'`)
			into.baseURLs[id] = tomlString(value)
		}
	}
}

// codexHome is codex's directory: CODEX_HOME, else ~/.codex.
func codexHome() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// settle fills in the run's model and provider from codex's config, where
// its arguments did not give them, and tells where its provider serves:
// "" for OpenAI's own API.
func (run *codexRun) settle() (endpoint string) {
	settings := codexSettings{baseURLs: map[string]string{}}
	if home := codexHome(); home != "" {
		if !run.noConfig {
			readCodexConfig(filepath.Join(home, "config.toml"), &settings)
		}
		if run.profile != "" {
			readCodexConfig(filepath.Join(home, run.profile+".config.toml"), &settings)
		}
	}
	if run.model == "" {
		run.model = settings.model
	}
	if run.provider == "" {
		run.provider = settings.provider
	}
	run.baseURLs = settings.baseURLs
	return providerEndpoint(run.provider, run.baseURLs)
}

// providerEndpoint is where a codex provider serves: OpenAI's own API, or
// one OPENAI_BASE_URL names, for "openai"; the host of a provider the
// config defines; else the provider's name, as "ollama".
func providerEndpoint(provider string, baseURLs map[string]string) string {
	if provider == "" || provider == "openai" {
		return endpointHost(os.Getenv("OPENAI_BASE_URL"), "api.openai.com")
	}
	if base, ok := baseURLs[provider]; ok {
		if host := endpointHost(base, ""); host != "" {
			return host
		}
	}
	return provider
}

// runCodexExec runs codex and tells `teller` of the run. It returns codex's
// exit code, or the signal it died of.
func runCodexExec(
	codex string,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	teller *printTeller,
) (code int, sig int) {
	run := describeCodexExec(args)
	if !run.exec {
		teller = nil
	}
	endpoint := ""
	if teller != nil {
		endpoint = run.settle()
	}
	cmd := exec.Command(codex, args...)
	// A run that prints events tells of itself on its output, and a text
	// run's output is its answer. A text run's stderr tells its model and
	// session, unless it is a terminal, which stays codex's.
	var out, errOut io.ReadCloser
	var prompt io.WriteCloser
	if teller != nil {
		var err error
		if out, err = cmd.StdoutPipe(); err != nil {
			fmt.Fprintf(stderr, "nexus: %v\n", err)
			return 127, 0
		}
		if !run.events && !isTerminal(stderr) {
			if errOut, err = cmd.StderrPipe(); err != nil {
				fmt.Fprintf(stderr, "nexus: %v\n", err)
				return 127, 0
			}
		}
		// The prompt codex reads from stdin is read as it passes; a
		// terminal stays codex's.
		if run.stdinPrompt && !isTerminalReader(stdin) {
			if prompt, err = cmd.StdinPipe(); err != nil {
				fmt.Fprintf(stderr, "nexus: %v\n", err)
				return 127, 0
			}
		}
	}
	if out == nil {
		cmd.Stdout = stdout
	}
	if errOut == nil {
		cmd.Stderr = stderr
	}
	if prompt == nil {
		cmd.Stdin = stdin
	}

	proc, ok := startSupervised(cmd, teller, stderr)
	if !ok {
		return 127, 0
	}
	defer proc.release()

	cwd, _ := os.Getwd()
	start := map[string]any{
		"program":    "codex",
		"prompt":     run.prompt,
		"model":      run.model,
		"cwd":        cwd,
		"tools_told": run.events,
	}
	if endpoint != "" {
		start["endpoint"] = endpoint
	}
	if run.sessionID != "" {
		start["session_id"] = run.sessionID
	}
	if run.resumed {
		start["resumed"] = true
	}
	teller.tell("print-start", start)

	watch := &codexWatch{tell: teller.tell, text: !run.events, noSession: run.ephemeral}
	if teller != nil {
		watch.prefix = teller.runID + ":"
	}
	if prompt != nil {
		// Not waited for: a codex that ends before it read all of it leaves
		// the copy blocked on the run's stdin, which ends with the run.
		go func() {
			told := copyPrompt(prompt, stdin)
			_ = prompt.Close()
			if told != "" {
				teller.tell("print-init", map[string]any{"prompt": told})
			}
		}()
	}
	var reading sync.WaitGroup
	if errOut != nil {
		header := &codexHeader{run: &run, tell: teller.tell}
		reading.Add(1)
		go func() {
			defer reading.Done()
			passOutput(errOut, stderr, header.line)
			_ = errOut.Close()
		}()
	}
	if out != nil {
		passOutput(out, stdout, watch.line)
		// Output no one reads any more: codex finds its pipe closed, as it
		// would writing to it alone.
		_ = out.Close()
	}
	reading.Wait()
	_ = cmd.Wait()

	code, sig, end := proc.ending()
	if answer := watch.result(); answer != "" {
		end["answer"] = answer
	}
	teller.finish("print-end", end, printEndWait)
	return code, sig
}

// copyPrompt passes r to w, and returns what passed, trimmed and cut to a
// prompt's length.
func copyPrompt(w io.Writer, r io.Reader) string {
	var head strings.Builder
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if head.Len() <= printTextMax*4 {
				head.Write(buf[:n])
			}
			if _, werr := w.Write(buf[:n]); werr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	text := head.String()
	for !utf8.ValidString(text) && text != "" {
		text = text[:len(text)-1]
	}
	return cut(strings.TrimSpace(text), printTextMax)
}

// isTerminalReader is whether r is a terminal.
func isTerminalReader(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// codexHeader reads the header a text run writes on stderr first, as
//
//	model: gpt-6-luna
//	provider: openai
//	session id: 01a1b19e-…
//
// between two "--------" lines, and tells what it says of the run.
type codexHeader struct {
	run  *codexRun
	tell func(subcommand string, payload map[string]any)
	// rules is how many of the header's rules were read: it is over at two.
	rules int
	init  map[string]any
}

func (h *codexHeader) line(b []byte) {
	if h.rules >= 2 {
		return
	}
	line := strings.TrimSpace(string(b))
	if line == "--------" {
		if h.rules++; h.rules == 2 && len(h.init) > 0 {
			h.tell("print-init", h.init)
		}
		return
	}
	if h.rules != 1 {
		return
	}
	key, value, ok := strings.Cut(line, ": ")
	if !ok || value == "" {
		return
	}
	if h.init == nil {
		h.init = map[string]any{}
	}
	switch key {
	case "model":
		h.init["model"] = value
	case "provider":
		// The provider codex settled on, where its arguments and config
		// were not read the same.
		if value != h.run.provider {
			if endpoint := providerEndpoint(value, h.run.baseURLs); endpoint != "" {
				h.init["endpoint"] = endpoint
			}
		}
	case "session id":
		if !h.run.ephemeral {
			h.init["session_id"] = value
		}
	}
}

// codexWatch reads a run's output: its events, the tools they run and how
// they end, and its answer; or, for a text run, the answer itself.
type codexWatch struct {
	tell func(subcommand string, payload map[string]any)
	// text: the output is the answer itself.
	text bool
	// prefix makes the run's tool ids its own: a run's items are numbered
	// from item_0, and a resumed run's again.
	prefix string
	// noSession: the run's session is not kept, so not told.
	noSession bool
	answer    string
	failure   string
	started   map[string]bool
}

type codexEvent struct {
	Type     string    `json:"type"`
	ThreadID string    `json:"thread_id"`
	Item     codexItem `json:"item"`
	Message  string    `json:"message"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type codexItem struct {
	ID               string `json:"id"`
	Type             string `json:"type"`
	Text             string `json:"text"`
	Command          string `json:"command"`
	AggregatedOutput string `json:"aggregated_output"`
	ExitCode         *int   `json:"exit_code"`
	Status           string `json:"status"`
	Changes          []struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	} `json:"changes"`
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Query     string          `json:"query"`
	Error     *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// codexTool is one tool an item runs, as the app names Claude's.
type codexTool struct {
	id    string
	name  string
	input map[string]any
}

func (w *codexWatch) line(b []byte) {
	if w.text {
		if utf8.RuneCountInString(w.answer) <= printTextMax {
			w.answer = cut(strings.TrimSpace(w.answer+"\n"+string(b)), printTextMax)
		}
		return
	}
	b = []byte(strings.TrimSpace(string(b)))
	if len(b) == 0 || b[0] != '{' {
		return
	}
	var event codexEvent
	if json.Unmarshal(b, &event) != nil {
		return
	}
	switch event.Type {
	case "thread.started":
		if event.ThreadID != "" && !w.noSession {
			w.tell("print-init", map[string]any{"session_id": event.ThreadID})
		}
	case "item.started":
		for _, tool := range w.toolsOf(event.Item) {
			w.toolUse(tool)
		}
	case "item.completed":
		item := event.Item
		if item.Type == "agent_message" {
			w.answer = cut(strings.TrimSpace(item.Text), printTextMax)
			return
		}
		failed, why := codexFailure(item)
		for _, tool := range w.toolsOf(item) {
			w.toolUse(tool)
			result := map[string]any{"tool_use_id": tool.id, "is_error": failed}
			if failed && why != "" {
				result["error"] = cut(why, printErrorMax)
			}
			w.tell("print-tool-result", result)
		}
	case "turn.failed":
		if event.Error != nil && event.Error.Message != "" {
			w.failure = cut(strings.TrimSpace(event.Error.Message), printTextMax)
		}
	case "error":
		if event.Message != "" {
			w.failure = cut(strings.TrimSpace(event.Message), printTextMax)
		}
	}
}

// toolUse tells a tool started, once.
func (w *codexWatch) toolUse(tool codexTool) {
	if w.started == nil {
		w.started = map[string]bool{}
	}
	if w.started[tool.id] {
		return
	}
	w.started[tool.id] = true
	w.tell("print-tool-use", map[string]any{
		"tool_use_id": tool.id,
		"tool_name":   tool.name,
		"tool_input":  tool.input,
	})
}

// result is the run's answer: its last message, else why its turn failed.
func (w *codexWatch) result() string {
	if w.answer != "" {
		return w.answer
	}
	return w.failure
}

// toolsOf is the tools an item runs: one for most, one for each file a
// patch changes, none for a message, reasoning or the todo list.
func (w *codexWatch) toolsOf(item codexItem) []codexTool {
	id := w.prefix + item.ID
	switch item.Type {
	case "command_execution":
		return []codexTool{{id, "Bash", map[string]any{"command": cut(shownCommand(item.Command), printTextMax)}}}
	case "file_change":
		tools := make([]codexTool, 0, len(item.Changes))
		for i, change := range item.Changes {
			name := "Edit"
			switch change.Kind {
			case "add":
				name = "Write"
			case "delete":
				name = "Delete"
			}
			tools = append(tools, codexTool{fmt.Sprintf("%s:%d", id, i), name, map[string]any{"file_path": change.Path}})
		}
		return tools
	case "mcp_tool_call":
		input, _ := trimInput(item.Arguments).(map[string]any)
		return []codexTool{{id, "mcp__" + item.Server + "__" + item.Tool, input}}
	case "web_search":
		return []codexTool{{id, "WebSearch", map[string]any{"query": cut(item.Query, printTextMax)}}}
	}
	return nil
}

// codexFailure is whether an item that ended failed, and why: a command's
// exit code and the last line it printed, or the error a call ended with.
func codexFailure(item codexItem) (bool, string) {
	switch item.Type {
	case "command_execution":
		if item.Status != "failed" && (item.ExitCode == nil || *item.ExitCode == 0) {
			return false, ""
		}
		if line := lastLine(item.AggregatedOutput); line != "" {
			return true, line
		}
		if item.ExitCode != nil {
			return true, fmt.Sprintf("exit code %d", *item.ExitCode)
		}
		return true, ""
	case "mcp_tool_call":
		if item.Error != nil && item.Error.Message != "" {
			return true, item.Error.Message
		}
		return item.Status == "failed", ""
	}
	return item.Status == "failed", ""
}

// lastLine is the last line of text that is not blank.
func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// shellScript is a command codex runs in a shell, as `/bin/bash -lc '…'`.
var shellScript = regexp.MustCompile(`(?s)^(?:\S*/)?(?:bash|zsh|sh) -l?c (.+)$`)

// powershellScript is a command codex runs in PowerShell on Windows.
var powershellScript = regexp.MustCompile(`(?is)^(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"? -Command (.+)$`)

// shownCommand is the command a tool row shows: the script, without the
// shell codex runs it in, as the app's Codex tabs show it.
func shownCommand(command string) string {
	m := shellScript.FindStringSubmatch(command)
	if m == nil {
		m = powershellScript.FindStringSubmatch(command)
	}
	if m == nil {
		return command
	}
	if word, ok := shellWord(m[1]); ok {
		return word
	}
	return command
}

// shellWord reads a shell-quoted string as the one word it is; false when
// it is not one word.
func shellWord(text string) (string, bool) {
	var word strings.Builder
	r := []rune(text)
	for i := 0; i < len(r); {
		switch ch := r[i]; {
		case ch == '\'':
			end := i + 1
			for end < len(r) && r[end] != '\'' {
				end++
			}
			if end >= len(r) {
				return "", false
			}
			word.WriteString(string(r[i+1 : end]))
			i = end + 1
		case ch == '"':
			i++
			for i < len(r) && r[i] != '"' {
				if r[i] == '$' || r[i] == '`' {
					return "", false
				}
				if r[i] == '\\' && i+1 < len(r) && strings.ContainsRune("\"\\$`\n", r[i+1]) {
					i++
				}
				word.WriteRune(r[i])
				i++
			}
			if i >= len(r) {
				return "", false
			}
			i++
		case ch == '\\':
			if i+1 < len(r) {
				word.WriteRune(r[i+1])
			}
			i += 2
		case strings.ContainsRune(" \t\n;&|<>()$`*?[]{}~#", ch):
			return "", false
		default:
			word.WriteRune(ch)
			i++
		}
	}
	return word.String(), true
}
