package chat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/nodeshim"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// Service owns the tabs' programs and their logs.
type Service struct {
	mu         sync.Mutex
	sink       EventSink
	sessions   map[tabKey]*session
	closedTabs map[tabKey]map[string]struct{}
	closed     bool
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
	// pending reserves the next line while stdin is writing. Output readers
	// can fill the capped log while publication waits for the write result.
	pending *entry
	// snaps takes the originals of the files a Codex program changes.
	snaps *snapshots
	// closed is set once the tab is closed: its program, still ending,
	// sends nothing more, as the tab may already run another.
	closed        bool
	tabGeneration string
}

// process is one run of a tab's program.
type process struct {
	generation   string
	canonicalCwd string
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	// outputs are the stdout and stderr pipes, closed once the exit is
	// reported, in case a process the program left behind holds them open.
	outputs []io.Closer
	// writeMu orders writes to stdin.
	writeMu sync.Mutex
	// codexGuidance is used under writeMu, alongside the requests it accompanies.
	codexGuidance    map[string]*codexGuidance
	codexCompactions atomic.Uint64
	// codexInitialized and codexExperimental are set under writeMu by the
	// program's first initialize request: Codex takes additionalContext only
	// from a connection that asked for experimentalApi there.
	codexInitialized  bool
	codexExperimental bool
	done              chan struct{}

	stderrMu   sync.Mutex
	stderrTail []byte

	stopOnce sync.Once

	// tree holds the processes the program starts, where its own process
	// group does not.
	tree tree
}

// New constructs an empty service.
func New() *Service {
	return &Service{sessions: make(map[tabKey]*session), closedTabs: make(map[tabKey]map[string]struct{})}
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
	d.Register("chat.subagentTranscript", service.SubagentTranscript)
	d.Register("chat.sessionFile", service.SessionFile)
	d.Register("chat.stageThread", service.StageThread)
	d.Register("chat.sessions", service.Sessions)
	d.Register("chat.deleteSession", service.DeleteSession)
	d.Register("chat.fileSizes", service.FileSizes)
	d.Register("chat.claudeConfig", service.ClaudeConfig)
	d.Register("chat.attach", service.Attach)
	d.Register("chat.pruneAttachments", service.PruneAttachments)
	d.Register("chat.profileDir", service.ProfileDir)
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
	s.closed = true
	sessions := make([]*session, 0, len(s.sessions))
	for key, sess := range s.sessions {
		sessions = append(sessions, sess)
		delete(s.sessions, key)
	}
	s.mu.Unlock()
	for _, sess := range sessions {
		sess.mu.Lock()
		sess.closed = true
		p := sess.proc
		sess.mu.Unlock()
		if p != nil {
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

	// Out of the tab's lock: the login shell may take a while to answer.
	env := mergeEnv(p.Env)
	sess, err := s.sessionFor(key, p.TabGeneration)
	if err != nil {
		return nil, err
	}
	return s.startSession(sess, p, env)
}

// startSession starts only while the session still owns the tab.
func (s *Service) startSession(sess *session, p StartParams, env []string) (any, error) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	s.mu.Lock()
	stale := s.sessions[sess.key] != sess || s.tabClosedLocked(sess.key, p.TabGeneration)
	s.mu.Unlock()
	if stale {
		return nil, staleTab(sess.key)
	}
	if p.TabGeneration != "" {
		sess.tabGeneration = p.TabGeneration
	}
	if sess.proc != nil {
		return StartResult{PID: sess.proc.cmd.Process.Pid, Attached: true, CanonicalCwd: sess.proc.canonicalCwd}, nil
	}
	defer func() {
		if sess.proc == nil {
			s.dropIfEmpty(sess)
		}
	}()
	var generation [16]byte
	if _, err := rand.Read(generation[:]); err != nil {
		return nil, requestFailed("chat.start process generation: %s", err)
	}

	// A node package's command runs as node on its script: through npm's
	// .cmd, cmd.exe would end a multi-line argument at its first line.
	cmd := nodeshim.Command(p.Program, p.Args...)
	cmd.Dir = p.Cwd
	cmd.Env = env
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
		return nil, requestFailed("chat.start: %s", err)
	}
	canonicalCwd, _ := filepath.EvalSymlinks(p.Cwd)
	proc := &process{
		generation:   hex.EncodeToString(generation[:]),
		canonicalCwd: canonicalCwd,
		cmd:          cmd,
		stdin:        stdin,
		outputs:      []io.Closer{stdout, stderr},
		done:         make(chan struct{}),
	}
	proc.holdTree()
	sess.proc = proc
	if p.ResetLog {
		sess.log.reset()
	}
	// The originals go with the log, and are of files under the folder.
	if p.ResetLog || sess.snaps == nil || sess.snaps.cwd != p.Cwd {
		sess.snaps = newSnapshots(p.Cwd)
	}
	start := map[string]any{"event": "start", "pid": cmd.Process.Pid, "processGeneration": proc.generation}
	if canonicalCwd != "" {
		start["canonicalCwd"] = canonicalCwd
	}
	if p.Resumed {
		start["resumed"] = true
	}
	sess.addSysLocked(start)

	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		sess.readStdout(proc, stdout)
	}()
	go func() {
		defer close(stderrDone)
		proc.readStderr(stderr)
	}()
	go sess.wait(proc, stdoutDone, stderrDone)
	return StartResult{PID: cmd.Process.Pid, CanonicalCwd: canonicalCwd}, nil
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
	proc := sess.running()
	if proc == nil {
		return nil, notRunning(key)
	}
	proc.writeMu.Lock()
	defer proc.writeMu.Unlock()
	sess.mu.Lock()
	if sess.closed || sess.proc != proc {
		sess.mu.Unlock()
		return nil, notRunning(key)
	}
	slot := sess.log.add(DirSys, nil, "")
	sess.pending = slot
	sess.mu.Unlock()

	message := json.RawMessage(bytes.Clone(line.Bytes()))
	written, err := proc.writeLocked(line.Bytes(), p.CodexContext)
	if err != nil {
		code := "chat.stdin-write-failed"
		if written > 0 {
			code = "chat.stdin-incomplete"
		}
		failure, _ := json.Marshal(map[string]string{"event": "stdin-failed", "code": code})
		sess.finishInput(slot, DirSys, failure)
		return nil, proto.NewError(code, fmt.Sprintf("chat.send: %s", err))
	}
	sess.finishInput(slot, DirIn, message)
	return struct{}{}, nil
}

// finishInput publishes the write outcome before any output produced while
// the write was in flight. Earlier logs still use the same DirIn format.
func (sess *session) finishInput(slot *entry, dir string, message json.RawMessage) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.pending = nil
	if sess.closed {
		return
	}
	sess.log.finishInput(slot, dir, message)
	sess.emitLineLocked(slot)
	for _, e := range sess.log.since(slot.seq) {
		sess.emitLineLocked(e)
	}
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
	if p.TabGeneration != "" {
		closed := s.closedTabs[key]
		if closed == nil {
			closed = make(map[string]struct{})
			s.closedTabs[key] = closed
		}
		closed[p.TabGeneration] = struct{}{}
	}
	sess := s.sessions[key]
	s.mu.Unlock()
	if sess != nil {
		sess.mu.Lock()
		s.mu.Lock()
		current := s.sessions[key] == sess
		if !current || (p.TabGeneration != "" && sess.tabGeneration != "" && sess.tabGeneration != p.TabGeneration) {
			s.mu.Unlock()
			sess.mu.Unlock()
			return struct{}{}, nil
		}
		delete(s.sessions, key)
		s.mu.Unlock()
		sess.closed = true
		if p.TabGeneration != "" {
			sess.tabGeneration = p.TabGeneration
		}
		proc := sess.proc
		sess.mu.Unlock()
		if proc != nil {
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
		if sess.pending != nil && e.seq >= sess.pending.seq {
			break
		}
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

// sessionFor returns or creates the session for a still-open generation.
func (s *Service) sessionFor(key tabKey, generation string) (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tabClosedLocked(key, generation) {
		return nil, staleTab(key)
	}
	if sess := s.sessions[key]; sess != nil {
		return sess, nil
	}
	sess := &session{service: s, key: key, createdAt: time.Now(), log: newLineLog(), tabGeneration: generation}
	s.sessions[key] = sess
	return sess, nil
}

// tabClosedLocked checks close intents even when they arrived before session creation.
func (s *Service) tabClosedLocked(key tabKey, generation string) bool {
	_, closed := s.closedTabs[key][generation]
	return s.closed || closed
}

func staleTab(key tabKey) error {
	return proto.NewError("chat.tab-closed", "chat tab "+key.tabID+" is closed")
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
	if sess.closed {
		return
	}
	e := sess.log.add(dir, message, text)
	if sess.pending == nil {
		sess.emitLineLocked(e)
	}
}

// emitLineLocked relays one committed input, output or system event.
func (sess *session) emitLineLocked(e *entry) {
	payload := sess.payload(e)
	if sess.proc != nil {
		payload.ProcessGeneration = sess.proc.generation
	}
	_ = sess.service.emit(EventLine, payload)
}

// addSysLocked logs a line of the agent's own.
func (sess *session) addSysLocked(fields map[string]any) {
	data, err := json.Marshal(fields)
	if err != nil {
		return
	}
	sess.addLocked(DirSys, data, "")
}

// addPinnedLocked logs a line of the agent's own that the log's cap keeps.
// It holds a file's text, so <, > and & are left as they are rather than
// escaped to six bytes each.
func (sess *session) addPinnedLocked(fields any) {
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(fields) != nil {
		return
	}
	if sess.closed {
		return
	}
	e := sess.log.addPinned(DirSys, bytes.TrimRight(data.Bytes(), "\n"))
	if sess.pending == nil {
		sess.emitLineLocked(e)
	}
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
func (sess *session) readStdout(proc *process, stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 64*1024)
	for {
		line, err := readLine(reader, maxLineBytes)
		if len(line) > 0 {
			sess.addOutput(proc, line)
		}
		if errors.Is(err, errLineTooLong) {
			sess.mu.Lock()
			if sess.proc == proc {
				sess.addSysLocked(map[string]any{"event": "dropped", "reason": "line too long"})
			}
			sess.mu.Unlock()
			continue
		}
		if err != nil {
			return
		}
	}
}

// addOutput records only lines from the process that still owns the session.
func (sess *session) addOutput(proc *process, line []byte) {
	line = bytes.TrimRight(line, "\r\n")
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.closed || sess.proc != proc {
		return
	}
	if json.Valid(line) {
		if isCodexCompaction(line) {
			proc.codexCompactions.Add(1)
		}
		sess.addLocked(DirOut, json.RawMessage(line), "")
		if sess.snaps != nil {
			for _, snap := range sess.snaps.take(line) {
				sess.addPinnedLocked(snap)
			}
		}
		return
	}
	sess.addLocked(DirOut, nil, string(line))
}

// wait reports the program's exit once its output has been read.
func (sess *session) wait(proc *process, stdoutDone, stderrDone <-chan struct{}) {
	state, err := proc.cmd.Process.Wait()
	proc.releaseTree()
	timer := time.NewTimer(exitDrainGrace)
	// A child the program left behind can hold both outputs open, as node
	// does under npm's codex.cmd: the grace ends the wait for all of them.
drain:
	for _, done := range []<-chan struct{}{stdoutDone, stderrDone} {
		select {
		case <-done:
		case <-timer.C:
			break drain
		}
	}
	timer.Stop()
	_ = proc.stdin.Close()
	for _, output := range proc.outputs {
		_ = output.Close()
	}

	exit := exitPayload(sess.key, state, err)
	exit.StderrTail = proc.stderr()
	exit.ProcessGeneration = proc.generation
	// Closing stdin releases any blocked write. Its outcome precedes exit.
	proc.writeMu.Lock()
	defer proc.writeMu.Unlock()
	sess.mu.Lock()
	fields := map[string]any{"event": "exit", "code": exit.Code}
	if exit.Signal != nil {
		fields["signal"] = *exit.Signal
	}
	if exit.StderrTail != "" {
		fields["stderrTail"] = exit.StderrTail
	}
	sess.addSysLocked(fields)
	// Explicit close already told the host its generation was gone. Legacy
	// close still expects the exit while no replacement session is present.
	told := !sess.closed || (sess.tabGeneration == "" && sess.service.lookup(sess.key) == nil)
	if told {
		_ = sess.service.emit(EventExit, exit)
	}
	if sess.proc == proc {
		sess.proc = nil
	}
	close(proc.done)
	sess.mu.Unlock()
}

// writeLocked writes one full line as part of the process's ordered send.
func (p *process) writeLocked(data []byte, context *codexContext) (int, error) {
	p.noteCodexInitialize(data)
	if context != nil {
		data = p.withCodexContext(data, *context)
	}
	line := append(data, '\n')
	n, err := p.stdin.Write(line)
	if err == nil && n != len(line) {
		err = io.ErrShortWrite
	}
	return n, err
}

// stop asks the program to exit, and kills it if it has not after stopGrace.
func (p *process) stop() {
	p.stopOnce.Do(func() {
		_ = p.signalTerm()
		timer := time.NewTimer(stopGrace)
		go func() {
			defer timer.Stop()
			select {
			case <-p.done:
			case <-timer.C:
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

// mergeEnv overlays the login shell's environment (./login_env.go), then
// the tab's variables, on the agent's environment. The app's wrapper
// directory goes first on the PATH, as for terminals, and variables a
// parent Claude Code session sets are left out, so the program starts as
// its own session.
func mergeEnv(overrides map[string]string) []string {
	merged := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || inheritedOnly(key) {
			continue
		}
		merged[key] = value
	}
	for key, value := range loginEnv() {
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
