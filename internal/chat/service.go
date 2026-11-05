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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// Service owns the tabs' programs and their logs.
type Service struct {
	mu       sync.Mutex
	sink     EventSink
	sessions map[tabKey]*session
}

type tabKey struct {
	workspaceID string
	tabID       string
}

// session is one tab: its log, and the program running for it, if any. A
// program that exits leaves the log, so the tab can still show the
// conversation and start the program again on it.
type session struct {
	service   *Service
	key       tabKey
	createdAt time.Time

	// mu orders the log and its events: a line is added and sent under it,
	// and chat.replay holds it while it sends the log, so live lines follow.
	mu   sync.Mutex
	log  *lineLog
	proc *process
}

// process is one run of a tab's program.
type process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	// outputs are the stdout and stderr pipes, closed once the exit is
	// reported, in case a process the program left behind holds them open.
	outputs []io.Closer
	// writeMu orders writes to stdin.
	writeMu sync.Mutex
	done    chan struct{}

	stderrMu   sync.Mutex
	stderrTail []byte

	stopOnce sync.Once
}

// New constructs an empty service.
func New() *Service {
	return &Service{sessions: make(map[tabKey]*session)}
}

// Register binds the chat.* methods onto the dispatcher.
func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("chat.start", service.Start)
	d.Register("chat.send", service.Send)
	d.Register("chat.stop", service.Stop)
	d.Register("chat.close", service.CloseTab)
	d.Register("chat.replay", service.Replay)
	d.Register("chat.list", service.List)
	d.Register("chat.exec", service.Exec)
	d.Register("chat.transcript", service.Transcript)
	d.Register("chat.attach", service.Attach)
	d.Register("chat.pruneAttachments", service.PruneAttachments)
}

// SetEventSink wires the service to the stdio host.
func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	s.sink = sink
	s.mu.Unlock()
}

// Close kills every program, as the agent shuts down.
func (s *Service) Close() {
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for key, sess := range s.sessions {
		sessions = append(sessions, sess)
		delete(s.sessions, key)
	}
	s.mu.Unlock()
	for _, sess := range sessions {
		if p := sess.running(); p != nil {
			p.kill()
		}
	}
}

// Start runs the tab's program, or attaches to the one running.
func (s *Service) Start(_ context.Context, raw json.RawMessage) (any, error) {
	var p StartParams
	if err := decodeParams(raw, &p, "chat.start params must include workspaceId, tabId, cwd and program"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.start")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" || strings.TrimSpace(p.Program) == "" {
		return nil, protocolError("chat.start cwd and program are required")
	}

	sess := s.sessionFor(key)
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.proc != nil {
		return StartResult{PID: sess.proc.cmd.Process.Pid, Attached: true}, nil
	}

	cmd := exec.Command(p.Program, p.Args...)
	cmd.Dir = p.Cwd
	cmd.Env = mergeEnv(p.Env)
	cmd.SysProcAttr = newSysProcAttr()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	if err := cmd.Start(); err != nil {
		s.dropIfEmpty(sess)
		return nil, requestFailed("chat.start: %s", err)
	}
	proc := &process{
		cmd:     cmd,
		stdin:   stdin,
		outputs: []io.Closer{stdout, stderr},
		done:    make(chan struct{}),
	}
	sess.proc = proc
	if p.ResetLog {
		sess.log.reset()
	}
	start := map[string]any{"event": "start", "pid": cmd.Process.Pid}
	if p.Resumed {
		start["resumed"] = true
	}
	sess.addSysLocked(start)

	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		sess.readStdout(stdout)
	}()
	go func() {
		defer close(stderrDone)
		proc.readStderr(stderr)
	}()
	go sess.wait(proc, stdoutDone, stderrDone)
	return StartResult{PID: cmd.Process.Pid}, nil
}

// Send writes one message to the tab's program and logs it.
func (s *Service) Send(_ context.Context, raw json.RawMessage) (any, error) {
	var p SendParams
	if err := decodeParams(raw, &p, "chat.send params must include workspaceId, tabId and message"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.send")
	if err != nil {
		return nil, err
	}
	var line bytes.Buffer
	if len(p.Message) == 0 || json.Compact(&line, p.Message) != nil {
		return nil, protocolError("chat.send message must be JSON")
	}
	sess := s.lookup(key)
	if sess == nil {
		return nil, notRunning(key)
	}
	sess.mu.Lock()
	proc := sess.proc
	if proc == nil {
		sess.mu.Unlock()
		return nil, notRunning(key)
	}
	message := json.RawMessage(bytes.Clone(line.Bytes()))
	sess.addLocked(DirIn, message, "")
	sess.mu.Unlock()

	// Written outside the log's lock: a program that stops reading its
	// input must not hold up its output.
	line.WriteByte('\n')
	if err := proc.write(line.Bytes()); err != nil {
		return nil, requestFailed("chat.send: %s", err)
	}
	return struct{}{}, nil
}

// Stop ends the tab's program and keeps its log.
func (s *Service) Stop(_ context.Context, raw json.RawMessage) (any, error) {
	var p TabParams
	if err := decodeParams(raw, &p, "chat.stop params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.stop")
	if err != nil {
		return nil, err
	}
	if sess := s.lookup(key); sess != nil {
		if proc := sess.running(); proc != nil {
			proc.stop()
			<-proc.done
		}
	}
	return struct{}{}, nil
}

// CloseTab ends the tab's program and forgets its log and its attached
// files: the tab was closed.
func (s *Service) CloseTab(_ context.Context, raw json.RawMessage) (any, error) {
	var p TabParams
	if err := decodeParams(raw, &p, "chat.close params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.close")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	sess := s.sessions[key]
	delete(s.sessions, key)
	s.mu.Unlock()
	if sess != nil {
		if proc := sess.running(); proc != nil {
			proc.stop()
		}
	}
	removeAttachments(key)
	return struct{}{}, nil
}

// Replay sends the tab's log again as chat.line events, then answers.
func (s *Service) Replay(_ context.Context, raw json.RawMessage) (any, error) {
	var p ReplayParams
	if err := decodeParams(raw, &p, "chat.replay params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.replay")
	if err != nil {
		return nil, err
	}
	sess := s.lookup(key)
	if sess == nil {
		return ReplayResult{Found: false}, nil
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	last := p.AfterSeq
	for _, e := range sess.log.since(p.AfterSeq) {
		payload := sess.payload(e)
		payload.Replay = true
		if err := s.emit(EventLine, payload); err != nil {
			return nil, requestFailed("chat.replay: %s", err)
		}
		last = e.seq
	}
	return ReplayResult{
		Found:     true,
		Running:   sess.proc != nil,
		Truncated: sess.log.truncated,
		LastSeq:   last,
	}, nil
}

// List reports the tabs the agent has logs for.
func (s *Service) List(_ context.Context, raw json.RawMessage) (any, error) {
	var p ListParams
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, protocolError("chat.list params must be an object")
		}
	}
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for key, sess := range s.sessions {
		if p.WorkspaceID == "" || key.workspaceID == p.WorkspaceID {
			sessions = append(sessions, sess)
		}
	}
	s.mu.Unlock()
	result := ListResult{Sessions: make([]SessionInfo, 0, len(sessions))}
	for _, sess := range sessions {
		info := SessionInfo{
			WorkspaceID: sess.key.workspaceID,
			TabID:       sess.key.tabID,
			CreatedAt:   sess.createdAt.UnixMilli(),
		}
		if proc := sess.running(); proc != nil {
			info.Running = true
			info.PID = proc.cmd.Process.Pid
		}
		result.Sessions = append(result.Sessions, info)
	}
	sort.Slice(result.Sessions, func(i, j int) bool {
		return result.Sessions[i].CreatedAt < result.Sessions[j].CreatedAt
	})
	return result, nil
}

// sessionFor returns the tab's session, making one when there is none.
func (s *Service) sessionFor(key tabKey) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.sessions[key]; sess != nil {
		return sess
	}
	sess := &session{service: s, key: key, createdAt: time.Now(), log: newLineLog()}
	s.sessions[key] = sess
	return sess
}

// dropIfEmpty forgets a session made for a program that did not start.
func (s *Service) dropIfEmpty(sess *session) {
	if sess.log.lastSeq() > 0 {
		return
	}
	s.mu.Lock()
	if s.sessions[sess.key] == sess {
		delete(s.sessions, sess.key)
	}
	s.mu.Unlock()
}

func (s *Service) lookup(key tabKey) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[key]
}

func (s *Service) emit(event string, payload any) error {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink(event, payload)
}

// running returns the session's program, nil when none runs.
func (sess *session) running() *process {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.proc
}

// addLocked logs one line and sends it. A send that fails, as when no
// client is connected, leaves the line for a later replay.
func (sess *session) addLocked(dir string, message json.RawMessage, text string) {
	e := sess.log.add(dir, message, text)
	_ = sess.service.emit(EventLine, sess.payload(e))
}

// addSysLocked logs a line of the agent's own.
func (sess *session) addSysLocked(fields map[string]any) {
	data, err := json.Marshal(fields)
	if err != nil {
		return
	}
	sess.addLocked(DirSys, data, "")
}

func (sess *session) payload(e *entry) LinePayload {
	return LinePayload{
		WorkspaceID: sess.key.workspaceID,
		TabID:       sess.key.tabID,
		Seq:         e.seq,
		Dir:         e.dir,
		Message:     e.message,
		Text:        e.text,
		At:          e.at,
	}
}

// readStdout logs each line the program writes.
func (sess *session) readStdout(stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 64*1024)
	for {
		line, err := readLine(reader, maxLineBytes)
		if len(line) > 0 {
			sess.addOutput(line)
		}
		if errors.Is(err, errLineTooLong) {
			sess.mu.Lock()
			sess.addSysLocked(map[string]any{"event": "dropped", "reason": "line too long"})
			sess.mu.Unlock()
			continue
		}
		if err != nil {
			return
		}
	}
}

func (sess *session) addOutput(line []byte) {
	line = bytes.TrimRight(line, "\r\n")
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if json.Valid(line) {
		sess.addLocked(DirOut, json.RawMessage(line), "")
		return
	}
	sess.addLocked(DirOut, nil, string(line))
}

// wait reports the program's exit once its output has been read.
func (sess *session) wait(proc *process, stdoutDone, stderrDone <-chan struct{}) {
	state, err := proc.cmd.Process.Wait()
	timer := time.NewTimer(exitDrainGrace)
	for _, done := range []<-chan struct{}{stdoutDone, stderrDone} {
		select {
		case <-done:
		case <-timer.C:
		}
	}
	timer.Stop()
	_ = proc.stdin.Close()
	for _, output := range proc.outputs {
		_ = output.Close()
	}

	exit := exitPayload(sess.key, state, err)
	exit.StderrTail = proc.stderr()
	sess.mu.Lock()
	if sess.proc == proc {
		sess.proc = nil
	}
	fields := map[string]any{"event": "exit", "code": exit.Code}
	if exit.Signal != nil {
		fields["signal"] = *exit.Signal
	}
	if exit.StderrTail != "" {
		fields["stderrTail"] = exit.StderrTail
	}
	sess.addSysLocked(fields)
	sess.mu.Unlock()
	close(proc.done)
	_ = sess.service.emit(EventExit, exit)
}

func (p *process) write(data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err := p.stdin.Write(data)
	return err
}

// stop asks the program to exit, and kills it if it has not after stopGrace.
func (p *process) stop() {
	p.stopOnce.Do(func() {
		_ = p.signalTerm()
		go func() {
			select {
			case <-p.done:
			case <-time.After(stopGrace):
				p.kill()
			}
		}()
	})
}

func (p *process) readStderr(stderr io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := stderr.Read(buf)
		if n > 0 {
			p.stderrMu.Lock()
			p.stderrTail = append(p.stderrTail, buf[:n]...)
			if over := len(p.stderrTail) - stderrTailBytes; over > 0 {
				p.stderrTail = append([]byte(nil), p.stderrTail[over:]...)
			}
			p.stderrMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (p *process) stderr() string {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	return strings.ToValidUTF8(string(p.stderrTail), "")
}

var errLineTooLong = errors.New("line too long")

// readLine reads one line of at most limit bytes. A longer line is read to
// its end and dropped, with errLineTooLong.
func readLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	tooLong := false
	for {
		chunk, err := reader.ReadSlice('\n')
		if !tooLong {
			if len(line)+len(chunk) > limit {
				tooLong = true
				line = nil
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if tooLong && err == nil {
			return nil, errLineTooLong
		}
		return line, err
	}
}

// mergeEnv overlays the tab's variables on the agent's environment. The
// app's wrapper directory goes first on the PATH, as for terminals, and
// variables a parent Claude Code session sets are left out, so the program
// starts as its own session.
func mergeEnv(overrides map[string]string) []string {
	merged := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || inheritedOnly(key) {
			continue
		}
		merged[key] = value
	}
	for key, value := range overrides {
		for existing := range merged {
			if sameEnvKey(existing, key) {
				delete(merged, existing)
			}
		}
		merged[key] = value
	}
	if dir := overrides[wrapperDirEnv]; dir != "" {
		prependPath(merged, dir)
	}
	if !hasLocale(merged) {
		merged["LANG"] = "C.UTF-8"
	}
	keys := make([]string, 0, len(merged))
	for key := range merged {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, key+"="+merged[key])
	}
	return env
}

const wrapperDirEnv = "NEXUS_WRAPPER_SELF_DIR"

// inheritedOnly names the variables of a Claude Code session the agent may
// have been started from, which would make the program take itself for a
// part of that session.
func inheritedOnly(key string) bool {
	switch key {
	case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT":
		return true
	}
	return false
}

// prependPath puts dir first on env's PATH, unless it is first already.
func prependPath(env map[string]string, dir string) {
	sep := string(os.PathListSeparator)
	for key, value := range env {
		if sameEnvKey(key, "PATH") {
			if value == dir || strings.HasPrefix(value, dir+sep) {
				return
			}
			if value != "" {
				dir += sep + value
			}
			env[key] = dir
			return
		}
	}
	env["PATH"] = dir
}

func hasLocale(env map[string]string) bool {
	for _, key := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
		if env[key] != "" {
			return true
		}
	}
	return false
}

func decodeParams(raw json.RawMessage, target any, message string) error {
	if len(raw) == 0 || json.Unmarshal(raw, target) != nil {
		return protocolError(message)
	}
	return nil
}

func keyFrom(workspaceID, tabID, method string) (tabKey, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	tabID = strings.TrimSpace(tabID)
	if workspaceID == "" || tabID == "" {
		return tabKey{}, protocolError(method + " workspaceId and tabId are required")
	}
	return tabKey{workspaceID: workspaceID, tabID: tabID}, nil
}

// CodeNotRunning is the error code for a tab whose program does not run.
const CodeNotRunning = "chat.not-running"

func notRunning(key tabKey) error {
	return proto.NewError(CodeNotRunning, "no program runs for tab "+key.tabID)
}

func requestFailed(format string, args ...any) error {
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf(format, args...)}
}

func protocolError(message string) error {
	return proto.ProtocolError(message)
}
