package chat

import (
	"bufio"
	"bytes"
	"container/list"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	"github.com/nexus-code/nexus-code/internal/redact"
)

type Service struct {
	mu              sync.Mutex
	sink            *connectionSink
	sessions        map[tabKey]*session
	closedTabs      map[closedTabGeneration]struct{}
	runs            map[runKey]*activeRun
	earlyRunCancels map[runKey]time.Time
	closedOrder     list.List
	closed          bool
	transcriptPages transcriptSnapshotCache
}

type tabKey struct {
	workspaceID string
	tabID       string
}

const (
	maxClosedTabGenerations = 4096
	closedTabRetention      = 2 * time.Minute
)

type closedTabGeneration struct {
	key        tabKey
	generation string
}

type closedTabRecord struct {
	closedTabGeneration
	expiresAt time.Time
}

type session struct {
	service   *Service
	key       tabKey
	createdAt time.Time

	mu            chatGate
	log           *lineLog
	proc          *process
	pending       *entry
	snaps         *snapshots
	closed        bool
	tabGeneration string
}

type process struct {
	generation        string
	canonicalCwd      string
	cmd               *exec.Cmd
	stdin             stdinWriter
	outputs           []io.Closer
	writeMu           chatGate
	codexGuidance     map[string]*codexGuidance
	codexCompactions  atomic.Uint64
	codexInitialized  bool
	codexExperimental bool
	done              chan struct{}

	stderrMu        sync.Mutex
	stderrTail      []byte
	stderrTruncated bool

	stopOnce sync.Once

	tree tree
}

func New() *Service {
	return &Service{sessions: make(map[tabKey]*session), closedTabs: make(map[closedTabGeneration]struct{})}
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("chat.start", service.Start)
	d.Register("chat.send", service.Send)
	d.Register("chat.stop", service.Stop)
	d.Register("chat.close", service.CloseTab)
	d.Register("chat.replay", service.Replay)
	d.Register("chat.list", service.List)
	d.Register("chat.exec", service.Exec)
	d.Register("chat.run", service.Run)
	d.Register("chat.cancelRun", service.CancelRun)
	d.Register("chat.transcript", service.Transcript)
	d.Register("chat.transcriptPage", service.TranscriptPage)
	d.Register("chat.runTranscript", service.RunTranscript)
	d.Register("chat.subagentTranscript", service.SubagentTranscript)
	d.Register("chat.sessionFile", service.SessionFile)
	d.Register("chat.stageThread", service.StageThread)
	d.Register("chat.rolloutTail", service.RolloutTail)
	d.Register("chat.sessions", service.Sessions)
	d.Register("chat.deleteSession", service.DeleteSession)
	d.Register("chat.fileSizes", service.FileSizes)
	d.Register("chat.claudeConfig", service.ClaudeConfig)
	d.Register("chat.attach", service.Attach)
	d.Register("chat.attachRoot", service.AttachRoot)
	d.Register("chat.pruneAttachments", service.PruneAttachments)
	d.Register("chat.touchAttachments", service.TouchAttachments)
	d.Register("chat.removeAttachments", service.RemoveAttachments)
	d.Register("chat.historySlots", service.HistorySlots)
	d.Register("chat.profileDir", service.ProfileDir)
	d.Register("chat.writeCodexCatalog", service.WriteCodexCatalog)
}

type connectionSink struct {
	ctx  context.Context
	emit EventSink
}

func (s *Service) SetEventSink(sink EventSink) {
	s.SetConnectionSink(nil, sink)
}

func (s *Service) SetConnectionSink(ctx context.Context, sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = &connectionSink{ctx: ctx, emit: sink}
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	runs := make([]<-chan struct{}, 0, len(s.runs))
	for _, active := range s.runs {
		active.cancel()
		runs = append(runs, active.done)
	}
	sessions := make([]*session, 0, len(s.sessions))
	for key, sess := range s.sessions {
		sessions = append(sessions, sess)
		delete(s.sessions, key)
	}
	s.mu.Unlock()
	deadline := time.NewTimer(runCloseGrace)
	defer deadline.Stop()
	for _, sess := range sessions {
		sess.mu.Lock()
		sess.closed = true
		p := sess.proc
		sess.mu.Unlock()
		if p != nil {
			p.kill()
		}
	}
	for _, done := range runs {
		select {
		case <-done:
		case <-deadline.C:
			return
		}
	}
}

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

	env := mergeEnv(p.Env)
	sess, err := s.sessionFor(key, p.TabGeneration)
	if err != nil {
		return nil, err
	}
	return s.startSession(sess, p, env)
}

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

	cmd := nodeshim.Command(p.Program, p.Args...)
	cmd.Dir = p.Cwd
	cmd.Env = env
	generationID := hex.EncodeToString(generation[:])
	stdin, childStdin, err := newChatStdin(generationID)
	if err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	defer childStdin.Close()
	cmd.Stdin = childStdin
	started := false
	defer func() {
		if !started {
			_ = stdin.Close()
		}
	}()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		return nil, requestFailed("chat.start: %s", err)
	}
	proc := &process{
		generation: generationID,
		cmd:        cmd,
		stdin:      stdin,
		outputs:    []io.Closer{stdout, stderr},
		done:       make(chan struct{}),
	}
	if err := proc.startOwned(); err != nil {
		return nil, requestFailed("chat.start: %s", err)
	}
	_ = childStdin.Close()
	started = true
	canonicalCwd, _ := filepath.EvalSymlinks(p.Cwd)
	proc.canonicalCwd = canonicalCwd
	sess.proc = proc
	if p.ResetLog {
		sess.log.reset()
	}
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
	if p.ConnectionChanged {
		start["connectionChanged"] = true
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

func (s *Service) Send(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SendParams
	if err := decodeParams(raw, &p, "chat.send params must include workspaceId, tabId and message"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.send")
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
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
	if err := sess.mu.lockContext(ctx); err != nil {
		return nil, err
	}
	proc := sess.proc
	sess.mu.Unlock()
	if proc == nil {
		return nil, notRunning(key)
	}
	if err := proc.writeMu.lockContext(ctx); err != nil {
		return nil, err
	}
	defer proc.writeMu.Unlock()
	if err := sess.mu.lockContext(ctx); err != nil {
		return nil, err
	}
	if sess.closed || sess.proc != proc {
		sess.mu.Unlock()
		return nil, notRunning(key)
	}
	slot := sess.log.reserveInput(line.Bytes())
	sess.pending = slot
	sess.mu.Unlock()

	message := json.RawMessage(bytes.Clone(line.Bytes()))
	written, err := proc.writeLocked(ctx, line.Bytes(), p.CodexContext)
	if err != nil {
		code := "chat.stdin-write-failed"
		if written > 0 {
			code = "chat.stdin-incomplete"
			_ = proc.stdin.Close()
		}
		failure, _ := json.Marshal(map[string]string{"event": "stdin-failed", "code": code})
		sess.finishInput(slot, DirSys, failure)
		return nil, proto.NewError(code, fmt.Sprintf("chat.send: %s", err))
	}
	sess.finishInput(slot, DirIn, message)
	return struct{}{}, nil
}

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
		s.rememberClosedTabLocked(closedTabGeneration{key, p.TabGeneration}, time.Now())
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
	if !p.KeepAttachments {
		removeAttachments(key)
	}
	return struct{}{}, nil
}

func (s *Service) Replay(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ReplayParams
	if err := decodeParams(raw, &p, "chat.replay params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.replay")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	sink, sess := s.sink, s.sessions[key]
	s.mu.Unlock()
	if err := s.checkReplayConnection(ctx, sink); err != nil {
		return nil, err
	}
	if sess == nil {
		return ReplayResult{Found: false}, nil
	}
	if err := sess.mu.lockContext(ctx); err != nil {
		return nil, err
	}
	defer sess.mu.Unlock()
	last := p.AfterSeq
	for _, e := range sess.log.since(p.AfterSeq) {
		if sess.pending != nil && e.seq >= sess.pending.seq {
			break
		}
		payload := sess.payload(e)
		payload.Replay = true
		if err := s.checkReplayConnection(ctx, sink); err != nil {
			return nil, err
		}
		if sink != nil && sink.emit != nil {
			if err := sink.emit(EventLine, payload); err != nil {
				if ctxErr := s.checkReplayConnection(ctx, sink); ctxErr != nil {
					return nil, ctxErr
				}
				return nil, requestFailed("chat.replay: %s", err)
			}
		}
		last = e.seq
	}
	if err := s.checkReplayConnection(ctx, sink); err != nil {
		return nil, err
	}
	return ReplayResult{
		Found:     true,
		Running:   sess.proc != nil,
		Truncated: sess.log.truncated,
		LastSeq:   last,
	}, nil
}

func (s *Service) checkReplayConnection(ctx context.Context, sink *connectionSink) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	current := s.sink == sink
	s.mu.Unlock()
	if !current || sink != nil && sink.ctx != nil && sink.ctx.Done() != ctx.Done() {
		return context.Canceled
	}
	return nil
}

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

func (s *Service) tabClosedLocked(key tabKey, generation string) bool {
	s.expireClosedTabsLocked(time.Now())
	_, closed := s.closedTabs[closedTabGeneration{key, generation}]
	return s.closed || closed
}

func (s *Service) rememberClosedTabLocked(tab closedTabGeneration, now time.Time) {
	s.expireClosedTabsLocked(now)
	if _, exists := s.closedTabs[tab]; exists {
		return
	}
	if len(s.closedTabs) == maxClosedTabGenerations {
		s.forgetClosedTabLocked(s.closedOrder.Front())
	}
	s.closedTabs[tab] = struct{}{}
	s.closedOrder.PushBack(closedTabRecord{tab, now.Add(closedTabRetention)})
}

func (s *Service) expireClosedTabsLocked(now time.Time) {
	for oldest := s.closedOrder.Front(); oldest != nil; oldest = s.closedOrder.Front() {
		if now.Before(oldest.Value.(closedTabRecord).expiresAt) {
			return
		}
		s.forgetClosedTabLocked(oldest)
	}
}

func (s *Service) forgetClosedTabLocked(element *list.Element) {
	record := s.closedOrder.Remove(element).(closedTabRecord)
	delete(s.closedTabs, record.closedTabGeneration)
}

func staleTab(key tabKey) error {
	return proto.NewError("chat.tab-closed", "chat tab "+key.tabID+" is closed")
}

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
	if sink == nil || sink.emit == nil {
		return nil
	}
	return sink.emit(event, payload)
}

func (sess *session) running() *process {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.proc
}

func (sess *session) addLocked(dir string, message json.RawMessage, text string) {
	if sess.closed {
		return
	}
	e := sess.log.add(dir, message, text)
	if sess.pending == nil {
		sess.emitLineLocked(e)
	}
}

func (sess *session) emitLineLocked(e *entry) {
	payload := sess.payload(e)
	if sess.proc != nil {
		payload.ProcessGeneration = sess.proc.generation
	}
	_ = sess.service.emit(EventLine, payload)
}

func (sess *session) addSysLocked(fields map[string]any) {
	data, err := json.Marshal(fields)
	if err != nil {
		return
	}
	sess.addLocked(DirSys, data, "")
}

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

func (sess *session) wait(proc *process, stdoutDone, stderrDone <-chan struct{}) {
	state, err := proc.cmd.Process.Wait()
	proc.releaseTree()
	timer := time.NewTimer(exitDrainGrace)
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

func (p *process) writeLocked(ctx context.Context, data []byte, guidance *codexContext) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	original := data
	var commit func()
	if guidance != nil {
		data, commit = p.prepareCodexContext(data, *guidance)
	}
	line := append(data, '\n')
	n, err := p.stdin.WriteContext(ctx, line)
	if n == len(line) {
		p.noteCodexInitialize(original)
		if commit != nil {
			commit()
		}
		return n, nil
	}
	if err == nil {
		err = io.ErrShortWrite
	}
	return n, err
}

func (p *process) startOwned() error {
	p.cmd.SysProcAttr = newSysProcAttr()
	if err := p.cmd.Start(); err != nil {
		return err
	}
	if err := p.holdTree(); err != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
		return err
	}
	return nil
}

func (p *process) kill() {
	_ = p.signalKill()
}

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
				p.stderrTruncated = true
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
	raw := p.stderrTail
	if p.stderrTruncated {
		_, raw, _ = bytes.Cut(raw, []byte("\n"))
	}
	tail := decodeOutput(raw)
	if p.stderrTruncated {
		return "[Chat stderr truncated]\n" + redact.Credentials(tail)
	}
	return redact.Credentials(tail)
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

const CodeNotRunning = "chat.not-running"

func notRunning(key tabKey) error {
	return proto.NewError(CodeNotRunning, "no program runs for tab "+key.tabID)
}

func requestFailed(format string, args ...any) error {
	return proto.RequestFailed(format, args...)
}

func protocolError(message string) error {
	return proto.ProtocolError(message)
}
