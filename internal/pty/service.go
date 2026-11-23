package pty

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/ports"
)

type Service struct {
	mu         sync.Mutex
	output     *outputSink
	sessions   map[tabKey]*session
	startPTY   func(spawnSpec) (*terminal, *child, error)
	spawning   map[tabKey]*pendingSpawn
	starts     sync.WaitGroup
	closed     bool
	closedTabs map[tabKey]time.Time
}

type pendingSpawn struct {
	done    chan struct{}
	session *session
	err     error
}

type outputSink struct {
	ctx  context.Context
	emit EventSink
	stop func() bool
}

const closedTabMemory = 10 * time.Second

type spawnSpec struct {
	shell string
	args  []string
	dir   string
	env   []string
	cols  int
	rows  int
}

type child struct {
	*os.Process
}

func (c *child) wait() (*os.ProcessState, error) {
	return c.Wait()
}

type tabKey struct {
	workspaceID string
	tabID       string
}

type session struct {
	service *Service
	key     tabKey
	child   *child
	master  *terminal

	writeMu sync.Mutex

	flowCond    *sync.Cond
	outstanding int
	paused      bool
	stopped     bool

	readDone        chan struct{}
	stopReadingOnce sync.Once
	exited          chan struct{}
	stopDone        chan struct{}
	stopOnce        sync.Once
	exitOnce        sync.Once

	ringMu      sync.Mutex
	ring        []byte
	ringHead    int
	ringSize    int
	ringDropped bool

	outputMu sync.Mutex

	createdAt time.Time

	sizeMu   sync.Mutex
	lastCols int
	lastRows int

	setSizeFn func(cols, rows int) error

	wiggleActive atomic.Int32
}

const wiggleRestoreDelay = 200 * time.Millisecond

func New() *Service {
	return &Service{
		output:     &outputSink{ctx: context.Background()},
		sessions:   make(map[tabKey]*session),
		closedTabs: make(map[tabKey]time.Time),
		startPTY:   startTerminal,
		spawning:   make(map[tabKey]*pendingSpawn),
	}
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("pty.spawn", service.Spawn)
	d.Register("pty.write", service.Write)
	d.Register("pty.resize", service.Resize)
	d.Register("pty.ack", service.Ack)
	d.Register("pty.kill", service.Kill)
	d.Register("pty.foregroundProcess", service.ForegroundProcess)
	d.Register("pty.listeningPorts", service.ListeningPorts)
	d.Register("pty.replay", service.Replay)
	d.Register("session.list", service.SessionList)
}

func (s *Service) SetEventSink(ctx context.Context, sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.output.stop != nil {
		s.output.stop()
	}
	output := &outputSink{ctx: ctx, emit: sink}
	s.output = output
	output.stop = context.AfterFunc(ctx, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.output == output {
			s.resetOutputWindowLocked()
		}
	})
	s.resetOutputWindowLocked()
}

func (s *Service) resetOutputWindowLocked() {
	for _, sess := range s.sessions {
		sess.outstanding = 0
		sess.paused = false
		sess.flowCond.Broadcast()
	}
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	if s.output.stop != nil {
		s.output.stop()
	}
	s.mu.Unlock()
	s.starts.Wait()

	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for key, session := range s.sessions {
		sessions = append(sessions, session)
		delete(s.sessions, key)
	}
	s.mu.Unlock()

	stopped := make([]<-chan struct{}, 0, len(sessions))
	for _, session := range sessions {
		stopped = append(stopped, session.stop())
	}
	for _, done := range stopped {
		<-done
	}
}

func (s *Service) Spawn(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SpawnParams
	if err := decodeParams(raw, &p, "pty.spawn params must include workspaceId, tabId, cwd, cols, and rows"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.spawn")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Cwd) == "" {
		return nil, protocolError("pty.spawn cwd is required")
	}
	if err := validateSize(p.Cols, p.Rows, "pty.spawn"); err != nil {
		return nil, err
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, requestFailed("PTY service is closed")
	}
	if starting := s.spawning[key]; starting != nil {
		s.mu.Unlock()
		select {
		case <-starting.done:
			if starting.err != nil {
				return nil, starting.err
			}
			return starting.session.attach(p.Cols, p.Rows), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if existing := s.sessions[key]; existing != nil {
		s.mu.Unlock()
		return existing.attach(p.Cols, p.Rows), nil
	}
	attempt := &pendingSpawn{done: make(chan struct{})}
	s.spawning[key] = attempt
	s.starts.Add(1)
	s.mu.Unlock()
	defer s.starts.Done()

	attempt.session, attempt.err = s.spawnSession(key, p)
	s.mu.Lock()
	delete(s.spawning, key)
	close(attempt.done)
	s.mu.Unlock()
	if attempt.err != nil {
		return nil, attempt.err
	}
	return SpawnResult{PID: attempt.session.child.Pid}, nil
}

func (s *Service) spawnSession(key tabKey, p SpawnParams) (*session, error) {
	shell := strings.TrimSpace(p.Shell)
	if shell == "" {
		shell = defaultShell()
	}
	master, child, err := s.startPTY(spawnSpec{
		shell: shell,
		args:  p.Args,
		dir:   p.Cwd,
		env:   mergeEnv(p.Env),
		cols:  p.Cols,
		rows:  p.Rows,
	})
	if err != nil {
		return nil, requestFailed("failed to spawn PTY: %s", err)
	}

	session := newSession(s, key, child, master)
	session.sizeMu.Lock()
	session.lastCols = p.Cols
	session.lastRows = p.Rows
	session.sizeMu.Unlock()

	closed := s.storeSession(key, session)

	go session.readLoop()
	go session.waitLoop()
	if closed {
		session.stop()
	}
	return session, nil
}

func (s *session) attach(cols, rows int) SpawnResult {
	_ = s.resize(cols, rows)
	return SpawnResult{PID: s.child.Pid, Attached: true}
}

func (s *Service) Write(_ context.Context, raw json.RawMessage) (any, error) {
	var p WriteParams
	if err := decodeParams(raw, &p, "pty.write params must include workspaceId, tabId, and data"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.write")
	if err != nil {
		return nil, err
	}
	session := s.lookup(key)
	if session == nil {
		return struct{}{}, nil
	}
	if err := session.write([]byte(p.Data)); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Resize(_ context.Context, raw json.RawMessage) (any, error) {
	var p ResizeParams
	if err := decodeParams(raw, &p, "pty.resize params must include workspaceId, tabId, cols, and rows"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.resize")
	if err != nil {
		return nil, err
	}
	if err := validateSize(p.Cols, p.Rows, "pty.resize"); err != nil {
		return nil, err
	}
	session := s.lookup(key)
	if session == nil {
		return struct{}{}, nil
	}
	if err := session.resize(p.Cols, p.Rows); err != nil {
		return nil, requestFailed("failed to resize PTY: %s", err)
	}
	return struct{}{}, nil
}

func (s *Service) Ack(ctx context.Context, raw json.RawMessage) (any, error) {
	var p AckParams
	if err := decodeParams(raw, &p, "pty.ack params must include workspaceId, tabId, and bytesConsumed"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.ack")
	if err != nil {
		return nil, err
	}
	bytesConsumed := p.BytesConsumed
	if bytesConsumed < 0 {
		return nil, protocolError("pty.ack bytesConsumed must be non-negative")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.sessions[key]; sess != nil && ctx.Done() == s.output.ctx.Done() && ctx.Err() == nil {
		sess.ackLocked(bytesConsumed)
	}
	return struct{}{}, nil
}

func (s *Service) Kill(_ context.Context, raw json.RawMessage) (any, error) {
	var p KillParams
	if err := decodeParams(raw, &p, "pty.kill params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.kill")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	session := s.sessions[key]
	if session == nil {
		now := time.Now()
		for closed, at := range s.closedTabs {
			if now.Sub(at) > closedTabMemory {
				delete(s.closedTabs, closed)
			}
		}
		s.closedTabs[key] = now
	}
	s.mu.Unlock()
	if session != nil {
		session.stop()
	}
	return struct{}{}, nil
}

func (s *Service) ForegroundProcess(_ context.Context, raw json.RawMessage) (any, error) {
	var p ForegroundProcessParams
	if err := decodeParams(raw, &p, "pty.foregroundProcess params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.foregroundProcess")
	if err != nil {
		return nil, err
	}
	session := s.lookup(key)
	if session == nil {
		return ForegroundProcessResult{Name: ""}, nil
	}
	name, alone := session.master.foregroundProcess(p.Alone)
	return ForegroundProcessResult{Name: name, Alone: alone}, nil
}

func (s *Service) ListeningPorts(_ context.Context, raw json.RawMessage) (any, error) {
	var p ListeningPortsParams
	if err := decodeParams(raw, &p, "pty.listeningPorts params must include workspaceId"); err != nil {
		return nil, err
	}
	workspaceID := strings.TrimSpace(p.WorkspaceID)
	if workspaceID == "" {
		return nil, protocolError("pty.listeningPorts workspaceId is required")
	}
	tabByShell := map[int]string{}
	s.mu.Lock()
	for key, session := range s.sessions {
		if key.workspaceID == workspaceID && session.child != nil && session.child.Process != nil {
			tabByShell[session.child.Pid] = key.tabID
		}
	}
	s.mu.Unlock()

	result := ListeningPortsResult{Ports: []ListeningPort{}}
	if len(tabByShell) == 0 {
		return result, nil
	}
	shells := make([]int, 0, len(tabByShell))
	for pid := range tabByShell {
		shells = append(shells, pid)
	}
	found, err := ports.Find(shells)
	if err != nil {
		return nil, err
	}
	for _, port := range found {
		result.Ports = append(result.Ports, ListeningPort{
			Port:    port.Port,
			PID:     port.PID,
			Process: port.Name,
			TabID:   tabByShell[port.Root],
		})
	}
	return result, nil
}

func newSession(service *Service, key tabKey, child *child, master *terminal) *session {
	s := &session{
		service:   service,
		key:       key,
		child:     child,
		master:    master,
		readDone:  make(chan struct{}),
		exited:    make(chan struct{}),
		stopDone:  make(chan struct{}),
		ring:      make([]byte, RingCapBytes),
		createdAt: time.Now(),
	}
	s.flowCond = sync.NewCond(&service.mu)
	return s
}

func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, MaxChunkSize)
	for {
		if err := s.waitForOutputWindow(context.Background(), nil); err != nil {
			return
		}
		n, err := s.master.Read(buf)
		if n > 0 {
			s.deliver(append([]byte(nil), buf[:n]...))
		}
		if err != nil {
			return
		}
	}
}

func (s *session) deliver(chunk []byte) {
	s.outputMu.Lock()
	defer s.outputMu.Unlock()
	s.ringAppend(chunk)
	_ = s.emitData(chunk, nil)
}

func (s *session) resize(cols int, rows int) error {
	if err := s.master.setSize(cols, rows); err != nil {
		return err
	}
	s.sizeMu.Lock()
	s.lastCols = cols
	s.lastRows = rows
	s.sizeMu.Unlock()
	return nil
}

func (s *session) waitLoop() {
	state, err := s.child.wait()
	close(s.exited)
	s.exitOnce.Do(func() {
		select {
		case <-s.readDone:
			s.stopReading()
		case <-timeAfter(exitDrainGrace):
			s.stopReading()
			<-s.readDone
		}
		s.service.removeSession(s.key, s)
		_ = s.service.emit(EventExit, exitPayload(s.key, state, err))
	})
}

func (s *session) waitForOutputWindow(ctx context.Context, replay *outputSink) error {
	s.service.mu.Lock()
	defer s.service.mu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if replay != nil && replay != s.service.output {
			return context.Canceled
		}
		if s.stopped {
			return errors.New("session stopped")
		}
		if !s.paused {
			return nil
		}
		s.flowCond.Wait()
	}
}

func (s *session) ackLocked(rawBytes int) {
	if rawBytes >= s.outstanding {
		s.outstanding = 0
	} else {
		s.outstanding -= rawBytes
	}
	if s.paused && s.outstanding <= LowWatermarkBytes {
		s.paused = false
		s.flowCond.Broadcast()
	}
}

func (s *session) wiggleSIGWINCH() {
	if !s.wiggleActive.CompareAndSwap(0, 1) {
		return
	}
	defer s.wiggleActive.Store(0)

	s.sizeMu.Lock()
	cols := s.lastCols
	rows := s.lastRows
	s.sizeMu.Unlock()

	if cols == 0 || rows == 0 || rows <= 1 {
		return
	}
	setSize := s.master.setSize
	if s.setSizeFn != nil {
		setSize = s.setSizeFn
	}
	_ = setSize(cols, rows-1)

	time.Sleep(wiggleRestoreDelay)

	s.sizeMu.Lock()
	cols = s.lastCols
	rows = s.lastRows
	s.sizeMu.Unlock()
	if cols == 0 || rows == 0 {
		return
	}
	_ = setSize(cols, rows)
}

func (s *session) write(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for len(data) > 0 {
		next := len(data)
		if next > maxWriteChunkSize {
			next = maxWriteChunkSize
		}
		if err := writeFull(s.master, data[:next]); err != nil {
			return requestFailed("failed to write PTY input: %s", err)
		}
		data = data[next:]
	}
	return nil
}

func (s *session) stop() <-chan struct{} {
	s.stopOnce.Do(func() {
		finish := s.stopChild()
		go func() {
			defer close(s.stopDone)
			finish()
		}()
	})
	return s.stopDone
}

func (s *session) stopReading() {
	s.service.mu.Lock()
	s.stopped = true
	s.paused = false
	s.flowCond.Broadcast()
	s.service.mu.Unlock()
	s.stopReadingOnce.Do(func() { _ = s.master.Close() })
}

func decodeParams(raw json.RawMessage, target any, message string) error {
	if len(raw) == 0 || json.Unmarshal(raw, target) != nil {
		return protocolError(message)
	}
	return nil
}

func keyFrom(workspaceID string, tabID string, method string) (tabKey, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	tabID = strings.TrimSpace(tabID)
	if workspaceID == "" {
		return tabKey{}, protocolError(method + " workspaceId is required")
	}
	if tabID == "" {
		return tabKey{}, protocolError(method + " tabId is required")
	}
	return tabKey{workspaceID: workspaceID, tabID: tabID}, nil
}

func validateSize(cols int, rows int, method string) error {
	if cols <= 0 || rows <= 0 {
		return protocolError(method + " cols and rows must be positive")
	}
	if cols > 65535 || rows > 65535 {
		return protocolError(method + " cols and rows must fit uint16")
	}
	return nil
}

func hasUTF8Locale(merged map[string]string) bool {
	for _, key := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
		if v, ok := merged[key]; ok && v != "" {
			return true
		}
	}
	return false
}

const wrapperDirEnv = "NEXUS_WRAPPER_SELF_DIR"

func hasEnvKey(env map[string]string, key string) bool {
	for existing := range env {
		if sameEnvKey(existing, key) {
			return true
		}
	}
	return false
}

func prependPath(env map[string]string, dir string) {
	for key, value := range env {
		if sameEnvKey(key, "PATH") {
			if value != "" {
				dir += string(os.PathListSeparator) + value
			}
			env[key] = dir
			return
		}
	}
	env["PATH"] = dir
}

func mergeEnv(overrides map[string]string) []string {
	merged := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
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
		merged[key] = agentpaths.ProfileEnvDir(key, value)
	}
	if !hasEnvKey(overrides, "PATH") {
		if dir := overrides[wrapperDirEnv]; dir != "" {
			prependPath(merged, dir)
		}
	}
	if dir := overrides["NEXUS_CMD_CODEX_DIR"]; runtime.GOOS == "windows" && dir != "" {
		prependPath(merged, dir)
	}
	if _, ok := merged["TERM"]; !ok {
		merged["TERM"] = "xterm-256color"
	}
	if !hasUTF8Locale(merged) {
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

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			if errors.Is(err, os.ErrClosed) {
				return io.ErrClosedPipe
			}
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (s *Service) storeSession(key tabKey, session *session) (closed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[key] = session
	if at, ok := s.closedTabs[key]; ok {
		delete(s.closedTabs, key)
		closed = time.Since(at) <= closedTabMemory
	}
	return closed
}

func (s *Service) lookup(key tabKey) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[key]
}

func (s *Service) removeSession(key tabKey, expected *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[key] == expected {
		delete(s.sessions, key)
		expected.ringMu.Lock()
		expected.ring = nil
		expected.ringSize = 0
		expected.ringMu.Unlock()
	}
}

func (s *session) ringAppend(data []byte) {
	if len(data) == 0 {
		return
	}
	s.ringMu.Lock()
	defer s.ringMu.Unlock()
	if s.ring == nil {
		return
	}
	cap := len(s.ring)
	if len(data) > cap {
		data = data[len(data)-cap:]
		s.ringDropped = true
	}
	for len(data) > 0 {
		tail := (s.ringHead + s.ringSize) % cap
		n := copy(s.ring[tail:], data)
		data = data[n:]
		s.ringSize += n
		if s.ringSize > cap {
			s.ringHead = (s.ringHead + s.ringSize - cap) % cap
			s.ringSize = cap
			s.ringDropped = true
		}
	}
}

func (s *session) ringContentsLocked() []byte {
	if s.ringSize == 0 || s.ring == nil {
		return nil
	}
	cap := len(s.ring)
	out := make([]byte, s.ringSize)
	n := copy(out, s.ring[s.ringHead:min(s.ringHead+s.ringSize, cap)])
	copy(out[n:], s.ring)
	if s.ringDropped {
		if i := bytes.IndexByte(out, '\n'); i >= 0 {
			out = out[i+1:]
		}
	}
	return out
}

func (s *Service) SessionList(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionListParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	s.mu.Lock()
	var infos []SessionInfo
	for key, sess := range s.sessions {
		if p.WorkspaceID != "" && key.workspaceID != p.WorkspaceID {
			continue
		}
		infos = append(infos, SessionInfo{
			WorkspaceID: key.workspaceID,
			TabID:       key.tabID,
			CreatedAt:   sess.createdAt.UnixMilli(),
		})
	}
	s.mu.Unlock()

	if infos == nil {
		infos = []SessionInfo{}
	}
	return SessionListResult{Sessions: infos}, nil
}

func (s *Service) Replay(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ReplayParams
	if err := decodeParams(raw, &p, "pty.replay params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.replay")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	sess, output := s.sessions[key], s.output
	s.mu.Unlock()
	if sess == nil {
		return struct{}{}, nil
	}
	if ctx.Done() != output.ctx.Done() {
		return nil, context.Canceled
	}

	sess.outputMu.Lock()
	sess.ringMu.Lock()
	replay := append([]byte(terminalReset), sess.ringContentsLocked()...)
	sess.ringMu.Unlock()
	err = sess.emitReplay(ctx, output, replay)
	sess.outputMu.Unlock()
	if err != nil {
		return nil, err
	}

	go sess.wiggleSIGWINCH()

	return struct{}{}, nil
}

func (s *session) emitReplay(ctx context.Context, output *outputSink, data []byte) error {
	stopWake := context.AfterFunc(ctx, func() {
		s.service.mu.Lock()
		defer s.service.mu.Unlock()
		s.flowCond.Broadcast()
	})
	defer stopWake()

	for len(data) > 0 {
		if err := s.waitForOutputWindow(ctx, output); err != nil {
			return err
		}
		n := min(len(data), MaxChunkSize)
		if err := s.emitData(data[:n], output); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (s *session) emitData(chunk []byte, replay *outputSink) error {
	svc := s.service
	svc.mu.Lock()
	output := svc.output
	if replay != nil && replay != output {
		svc.mu.Unlock()
		return context.Canceled
	}
	if err := output.ctx.Err(); err != nil || output.emit == nil {
		svc.mu.Unlock()
		return err
	}
	s.outstanding += len(chunk)
	if s.outstanding >= HighWatermarkBytes {
		s.paused = true
	}
	svc.mu.Unlock()

	err := output.emit(EventData, DataPayload{
		WorkspaceID: s.key.workspaceID,
		TabID:       s.key.tabID,
		Chunk:       base64.StdEncoding.EncodeToString(chunk),
		Replay:      replay != nil,
	})
	if err != nil {
		svc.mu.Lock()
		if svc.output == output {
			s.ackLocked(len(chunk))
		}
		svc.mu.Unlock()
	}
	return err
}

func (s *Service) emit(event string, payload any) error {
	s.mu.Lock()
	sink := s.output.emit
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink(event, payload)
}

func timeAfter(duration time.Duration) <-chan time.Time {
	return time.After(duration)
}
