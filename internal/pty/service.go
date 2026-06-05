package pty

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	creackpty "github.com/creack/pty"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	"golang.org/x/sys/unix"
)

// Service owns the registry of active PTY-backed terminal sessions.
type Service struct {
	mu       sync.Mutex
	sink     EventSink
	sessions map[tabKey]*session
}

// tabKey is the domain identity for a terminal session.
type tabKey struct {
	workspaceID string
	tabID       string
}

// session owns one child process, its master PTY, per-tab flow control, and the
// ring buffer that preserves output while no dialer is attached.
type session struct {
	service *Service
	key     tabKey
	cmd     *exec.Cmd
	master  *os.File

	writeMu sync.Mutex

	flowMu      sync.Mutex
	flowCond    *sync.Cond
	outstanding int
	paused      bool
	stopped     bool

	readDone chan struct{}
	stopOnce sync.Once
	exitOnce sync.Once

	// ring is the fixed-capacity circular output buffer used while no dialer is
	// attached, and as a temporary queue while replay is in progress.  ringMu
	// serializes all reads/writes to ring*, ringHead, and ringSize.
	ringMu   sync.Mutex
	ring     []byte
	ringHead int // index of the oldest byte in ring
	ringSize int // number of valid bytes currently stored

	// replayActive is set to 1 while a pty.replay call is draining the ring.
	// readLoop checks this flag: when set, live PTY bytes are diverted to the
	// ring instead of being emitted directly, so replay data always precedes
	// live data on the wire.
	replayActive atomic.Int32

	// replayMu ensures at most one concurrent replay per session.
	replayMu sync.Mutex

	// createdAt is the wall-clock time when the PTY was spawned, exported in
	// session.list so the client can match sessions to its pending tab state.
	createdAt time.Time

	// lastCols and lastRows record the most recent PTY geometry set by Spawn or
	// Resize.  They are used by wiggleSIGWINCH after replay to force a full
	// TUI repaint.  Zero means the size has never been explicitly set (e.g. a
	// session that exited before the first resize), in which case the wiggle is
	// skipped.  Protected by sizeMu.
	sizeMu   sync.Mutex
	lastCols int
	lastRows int

	// setSizeFn is the function used by wiggleSIGWINCH to apply a PTY geometry
	// change.  Production code leaves it nil (creackpty.Setsize is used).
	// Tests may replace it with a recording stub to verify call sequences
	// without a real PTY fd.
	setSizeFn func(f *os.File, ws *creackpty.Winsize) error

	// wiggleActive guards against overlapping wiggleSIGWINCH goroutines when
	// replays arrive in quick succession (e.g. repeated reconnects).  A wiggle
	// already in flight will repaint the TUI anyway, so a second one is skipped.
	wiggleActive atomic.Int32
}

// wiggleRestoreDelay is how long wiggleSIGWINCH holds the shrunken (rows-1)
// geometry before restoring the original size.
//
// The gap is load-bearing, not cosmetic.  SIGWINCH is a non-queued Unix
// signal: two deliveries while the target has not yet run its handler merge
// into one pending signal.  Worse, handlers read the *current* size via
// TIOCGWINSZ — if shrink and restore land back-to-back, the handler runs
// after the restore, reads a size identical to its cached one, and skips the
// repaint entirely (Node's tty layer only emits "resize" when the polled size
// actually differs).  That is exactly the blank-screen-after-reattach symptom
// this wiggle exists to fix.  Holding rows-1 for a beat lets the shrink
// SIGWINCH be observed at the shrunken size, guaranteeing a real size delta
// in both directions.
const wiggleRestoreDelay = 200 * time.Millisecond

// New constructs an empty PTY service registry.
func New() *Service {
	return &Service{sessions: make(map[tabKey]*session)}
}

// Register binds every pty.* and session.* method onto the dispatcher.
func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("pty.spawn", service.Spawn)
	d.Register("pty.write", service.Write)
	d.Register("pty.resize", service.Resize)
	d.Register("pty.ack", service.Ack)
	d.Register("pty.kill", service.Kill)
	d.Register("pty.foregroundProcess", service.ForegroundProcess)
	d.Register("pty.replay", service.Replay)
	d.Register("session.list", service.SessionList)
}

// SetEventSink wires the service to the stdio host after both are constructed.
func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

// ResetFlowControl zeroes outstanding renderer debt and unblocks every paused
// readLoop across all live sessions.
//
// Call this immediately after wiring a new dialer's event sink.  During the
// zombie window between a silent disconnect and the new dialer's takeover, the
// old dialer's OS socket buffer may have absorbed writes that the renderer
// never received — so noteEmitted debt accumulates without matching acks.  If
// that debt crossed HighWatermarkBytes the readLoop is already blocked in
// waitForOutputWindow.  The new renderer has no knowledge of the old debt and
// will never send acks for it, causing permanent deadlock ("reconnected but
// terminal frozen").
//
// Resetting here is correct because the stale debt belongs to the old
// renderer generation.  In-flight bytes that landed only in the OS buffer (not
// in the renderer) are already lost — the plan explicitly accepts this as
// in-flight loss.  Carrying forward a fictitious debt would only harm the new
// renderer.
func (s *Service) ResetFlowControl() {
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	s.mu.Unlock()

	for _, sess := range sessions {
		sess.resetFlow()
	}
}

// Close terminates all active PTY sessions.
func (s *Service) Close() {
	s.mu.Lock()
	sessions := make([]*session, 0, len(s.sessions))
	for key, session := range s.sessions {
		sessions = append(sessions, session)
		delete(s.sessions, key)
	}
	s.mu.Unlock()

	for _, session := range sessions {
		session.stop(syscall.SIGKILL)
	}
}

// Spawn starts one shell process under a PTY and begins forwarding output events.
func (s *Service) Spawn(_ context.Context, raw json.RawMessage) (any, error) {
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

	if existing := s.lookup(key); existing != nil && existing.cmd.Process != nil {
		return SpawnResult{PID: existing.cmd.Process.Pid}, nil
	}

	shell := strings.TrimSpace(p.Shell)
	if shell == "" {
		shell = defaultShell()
	}
	cmd := exec.Command(shell, p.Args...)
	cmd.Dir = p.Cwd
	cmd.Env = mergeEnv(p.Env)
	cmd.SysProcAttr = newSysProcAttr()

	master, err := creackpty.StartWithSize(cmd, &creackpty.Winsize{Rows: uint16(p.Rows), Cols: uint16(p.Cols)})
	if err != nil {
		return nil, requestFailed("failed to spawn PTY: %s", err)
	}

	session := newSession(s, key, cmd, master)
	session.sizeMu.Lock()
	session.lastCols = p.Cols
	session.lastRows = p.Rows
	session.sizeMu.Unlock()

	if stored := s.storeSession(key, session); stored != session {
		session.stop(syscall.SIGKILL)
		if stored.cmd.Process == nil {
			return nil, requestFailed("pty session already exists for tab %s", key.tabID)
		}
		return SpawnResult{PID: stored.cmd.Process.Pid}, nil
	}

	go session.readLoop()
	go session.waitLoop()
	return SpawnResult{PID: cmd.Process.Pid}, nil
}

// Write sends user input bytes to the child PTY.
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

// Resize updates the child PTY geometry.
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
	if err := creackpty.Setsize(session.master, &creackpty.Winsize{Rows: uint16(p.Rows), Cols: uint16(p.Cols)}); err != nil {
		return nil, requestFailed("failed to resize PTY: %s", err)
	}
	session.sizeMu.Lock()
	session.lastCols = p.Cols
	session.lastRows = p.Rows
	session.sizeMu.Unlock()
	return struct{}{}, nil
}

// Ack reduces one session's renderer debt and resumes output once the low watermark is reached.
func (s *Service) Ack(_ context.Context, raw json.RawMessage) (any, error) {
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
	session := s.lookup(key)
	if session == nil {
		return struct{}{}, nil
	}
	session.ack(bytesConsumed)
	return struct{}{}, nil
}

// Kill terminates a PTY session's child process group.
func (s *Service) Kill(_ context.Context, raw json.RawMessage) (any, error) {
	var p KillParams
	if err := decodeParams(raw, &p, "pty.kill params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.kill")
	if err != nil {
		return nil, err
	}
	session := s.lookup(key)
	if session == nil {
		return struct{}{}, nil
	}
	session.stop(syscall.SIGKILL)
	return struct{}{}, nil
}

// ForegroundProcess returns the basename of the program currently in the PTY
// foreground process group.
//
// Used by the renderer to label tabs running OSC-mute TUIs: when xterm.js
// detects alt-screen ENTER (`\x1b[?47h` / `\x1b[?1047h` / `\x1b[?1049h`), it
// calls this RPC once and applies the returned name as the tab's
// processTitle. Repeat polling is intentionally avoided — TUIs sit in a single
// process for their whole session, and child commands they spawn (e.g. lazygit
// shelling out to `git`) are short-lived.
//
// Lookup path: TIOCGPGRP ioctl on the master fd gives the foreground process
// group id, then `ps -o comm= -p PGID` resolves the program name. We strip any
// leading path so callers see "lazygit" rather than "/usr/local/bin/lazygit".
//
// All error paths return an empty `Name` rather than failing the RPC: the
// renderer treats empty as "no info" and leaves the existing title alone, so
// silent fallback never overwrites a working OSC-based title with empty.
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
	pgid, ioErr := unix.IoctlGetInt(int(session.master.Fd()), unix.TIOCGPGRP)
	if ioErr != nil || pgid <= 0 {
		return ForegroundProcessResult{Name: ""}, nil
	}
	// `ps -o comm= -p PGID`: -o comm= prints only the COMM column (no header),
	// macOS와 Linux 모두 동일한 형태로 동작. 짧은 실행 시간(~30ms)이라 alt-enter
	// 같은 sporadic 호출에는 충분.
	out, execErr := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pgid)).Output()
	if execErr != nil {
		return ForegroundProcessResult{Name: ""}, nil
	}
	name := strings.TrimSpace(string(out))
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	return ForegroundProcessResult{Name: name}, nil
}

// newSession links process state with its flow-control condition variable and
// initialises the ring buffer for output preservation during dialer absence.
func newSession(service *Service, key tabKey, cmd *exec.Cmd, master *os.File) *session {
	s := &session{
		service:   service,
		key:       key,
		cmd:       cmd,
		master:    master,
		readDone:  make(chan struct{}),
		ring:      make([]byte, RingCapBytes),
		createdAt: time.Now(),
	}
	s.flowCond = sync.NewCond(&s.flowMu)
	return s
}

// readLoop serially emits PTY data, applying renderer-credit backpressure before
// each read.
//
// When the dialer is absent (emit returns an error) or a pty.replay call is in
// progress (replayActive=1), bytes are written to the session ring buffer instead
// of being emitted directly.  This keeps the single readLoop goroutine as the
// sole sequencer: replay data is always flushed before live data because replay
// holds replayActive for the full duration of its drain.
//
// The credit gate (waitForOutputWindow) is bypassed when buffering to ring —
// there is no renderer present to send acks, so blocking would deadlock.  The
// gate is re-engaged on every normal emit so backpressure is restored as soon
// as a dialer reconnects.
func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, MaxChunkSize)
	for {
		// If a replay is in progress, route PTY bytes to ring so they are queued
		// behind the replay snapshot already in flight.  Once replayActive is
		// cleared the normal emit path resumes.
		if s.replayActive.Load() == 1 {
			n, err := s.master.Read(buf)
			if n > 0 {
				s.ringAppend(buf[:n])
			}
			if err != nil {
				return
			}
			continue
		}

		// Normal path: apply credit-gate backpressure before each read.
		if !s.waitForOutputWindow() {
			return
		}
		n, err := s.master.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.noteEmitted(len(chunk))
			if emitErr := s.service.emit(EventData, DataPayload{WorkspaceID: s.key.workspaceID, TabID: s.key.tabID, Chunk: base64.StdEncoding.EncodeToString(chunk)}); emitErr != nil {
				// Dialer is gone — preserve output in the ring so a reattaching
				// dialer can recover it via pty.replay.  The PTY child is NOT
				// killed; it continues running until the reattach grace expires.
				// Undo the renderer debt — there is no renderer to send acks, so
				// leaving the debt would permanently pause readLoop on the next
				// waitForOutputWindow check once a dialer reconnects.
				s.ack(len(chunk))
				s.ringAppend(chunk)
			}
		}
		if err != nil {
			return
		}
	}
}

// waitLoop reports exactly one exit event after the child has terminated.
func (s *session) waitLoop() {
	err := s.cmd.Wait()
	s.exitOnce.Do(func() {
		select {
		case <-s.readDone:
		case <-timeAfter(exitDrainGrace):
			s.stopReading()
			<-s.readDone
		}
		s.service.removeSession(s.key, s)
		_ = s.service.emit(EventExit, exitPayloadFromWait(s.key, err))
	})
}

// waitForOutputWindow blocks while a prior emission has crossed the high watermark.
func (s *session) waitForOutputWindow() bool {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	for s.paused && !s.stopped {
		s.flowCond.Wait()
	}
	return !s.stopped
}

// noteEmitted adds raw bytes to renderer debt and toggles the paused state at HIGH.
func (s *session) noteEmitted(rawBytes int) {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	s.outstanding += rawBytes
	if s.outstanding >= HighWatermarkBytes {
		s.paused = true
	}
}

// ack applies renderer credit and wakes the reader only after LOW is reached.
func (s *session) ack(rawBytes int) {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
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

// resetFlow clears outstanding renderer debt and wakes any paused readLoop.
// Called by Service.ResetFlowControl on dialer generation change — the old
// renderer's debt must not carry over to the new one.
func (s *session) resetFlow() {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	s.outstanding = 0
	if s.paused {
		s.paused = false
		s.flowCond.Broadcast()
	}
}

// wiggleSIGWINCH forces a full TUI repaint after replay by shrinking the PTY
// by one row, holding that geometry for wiggleRestoreDelay, then restoring
// the original size.  The hold is what makes the shrink SIGWINCH observable
// at the shrunken size — see the wiggleRestoreDelay comment for why two
// back-to-back Setsize calls coalesce into a no-op for the foreground TUI.
//
// The restore re-reads lastCols/lastRows instead of reusing the values
// captured before the sleep: if a real pty.resize lands during the hold, the
// restore must not clobber the fresh geometry with stale numbers.  Restoring
// to an already-applied size produces no geometry change and therefore no
// spurious SIGWINCH.
//
// The wiggle is skipped when:
//   - lastRows/lastCols are zero (size never recorded — session exited before
//     first resize or Spawn geometry was not stored yet).
//   - rows-1 would underflow to zero (1-row terminal, pathological).
//   - Another wiggle is already in flight (it will repaint the TUI anyway).
//   - The PTY master file is already closed (stopped session).
//
// Best-effort: errors from Setsize are silently ignored.  A failed wiggle
// leaves the TUI stale until the user presses a key or the TUI self-refreshes,
// which matches the pre-fix behavior and is preferable to surfacing an error
// from a cosmetic step.
//
// Blocking for wiggleRestoreDelay; callers on a latency-sensitive path should
// run it in a goroutine.
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
	setSize := creackpty.Setsize
	if s.setSizeFn != nil {
		setSize = s.setSizeFn
	}
	// Shrink by one row to make the geometry change.
	_ = setSize(s.master, &creackpty.Winsize{Rows: uint16(rows - 1), Cols: uint16(cols)})

	// Hold the shrunken size long enough for the foreground process to run
	// its SIGWINCH handler and observe rows-1.
	time.Sleep(wiggleRestoreDelay)

	// Restore — re-read the recorded size in case a real resize arrived
	// during the hold.
	s.sizeMu.Lock()
	cols = s.lastCols
	rows = s.lastRows
	s.sizeMu.Unlock()
	if cols == 0 || rows == 0 {
		return
	}
	_ = setSize(s.master, &creackpty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

// write serializes and chunks input writes to preserve one-session input order.
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

// stop terminates the child process group and unblocks the reader.
func (s *session) stop(signal syscall.Signal) {
	s.stopOnce.Do(func() {
		s.stopReading()
		_ = signalProcessGroup(s.cmd.Process, signal)
	})
}

// stopReading wakes any paused reader and closes the PTY master.
func (s *session) stopReading() {
	s.flowMu.Lock()
	s.stopped = true
	s.paused = false
	s.flowCond.Broadcast()
	s.flowMu.Unlock()
	_ = s.master.Close()
}

// decodeParams unmarshals a request body into a strongly typed PTY parameter struct.
func decodeParams(raw json.RawMessage, target any, message string) error {
	if len(raw) == 0 || json.Unmarshal(raw, target) != nil {
		return protocolError(message)
	}
	return nil
}

// keyFrom validates and builds the workspace/tab identity used by the session map.
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

// validateSize keeps PTY geometry inside the uint16 winsize range.
func validateSize(cols int, rows int, method string) error {
	if cols <= 0 || rows <= 0 {
		return protocolError(method + " cols and rows must be positive")
	}
	if cols > 65535 || rows > 65535 {
		return protocolError(method + " cols and rows must fit uint16")
	}
	return nil
}

// shellFallbackCandidates is the ordered probe list used only when $SHELL
// is absent from the agent environment. bash precedes zsh deliberately: an
// unconfigured zsh drops the user into the interactive zsh-newuser-install
// wizard, so it is the worse default. New shells can be appended here.
var shellFallbackCandidates = []string{"/bin/bash", "/bin/zsh", "/bin/sh"}

// defaultShell resolves the shell for a PTY on the agent's own host. It
// prefers $SHELL — the user's configured login shell, which the remote
// sshd populates from /etc/passwd — and only when that is unset probes
// shellFallbackCandidates so a missing $SHELL never spawns a nonexistent
// binary.
func defaultShell() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	for _, candidate := range shellFallbackCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "/bin/sh"
}

// hasUTF8Locale reports whether the merged env carries any non-empty
// LANG / LC_ALL / LC_CTYPE — the three variables bash readline consults
// to enable multibyte input. Empty values count as unset because shells
// treat them identically to absence.
func hasUTF8Locale(merged map[string]string) bool {
	for _, key := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
		if v, ok := merged[key]; ok && v != "" {
			return true
		}
	}
	return false
}

// mergeEnv overlays spawn-specific variables on the agent process environment.
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
		merged[key] = value
	}
	if _, ok := merged["TERM"]; !ok {
		merged["TERM"] = "xterm-256color"
	}
	// UTF-8 locale fallback. When the agent host is bootstrapped via
	// `bash -lc 'exec agent ...'` on a remote that ships no LANG / LC_*
	// (clean Docker/LXC images, slim Linux installs, minimal CI runners),
	// the inherited environment leaves bash readline on POSIX/C — which
	// rejects multibyte input and breaks Korean / Japanese / Chinese
	// keystrokes in the terminal. We only inject `C.UTF-8` when none of
	// LANG, LC_ALL, LC_CTYPE carry a non-empty value, so a user-configured
	// locale (e.g. `LANG=ko_KR.UTF-8`) is never silently overridden.
	// C.UTF-8 is the safest default: present on Linux glibc/musl and
	// macOS 12+, and gracefully degrades to POSIX when the system has no
	// matching definition installed.
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

// writeFull retries partial writes until the input slice has reached the PTY master.
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

// storeSession inserts a session unless another goroutine already claimed the key.
func (s *Service) storeSession(key tabKey, session *session) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.sessions[key]; existing != nil {
		return existing
	}
	s.sessions[key] = session
	return session
}

// lookup returns the active session for key, if any.
func (s *Service) lookup(key tabKey) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[key]
}

// removeSession deletes key only if it still points at expected, and releases
// the session ring buffer so the backing memory can be garbage-collected.
func (s *Service) removeSession(key tabKey, expected *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[key] == expected {
		delete(s.sessions, key)
		expected.ringMu.Lock()
		expected.ring = nil // allow GC; ringSize stays for safety
		expected.ringSize = 0
		expected.ringMu.Unlock()
	}
}

// ringAppend writes data into the session ring buffer, dropping the oldest
// bytes when the ring is full.  Safe to call from any goroutine.
func (s *session) ringAppend(data []byte) {
	if len(data) == 0 {
		return
	}
	s.ringMu.Lock()
	defer s.ringMu.Unlock()
	if s.ring == nil {
		return // session already removed
	}
	cap := len(s.ring)
	for _, b := range data {
		if s.ringSize == cap {
			// Ring full: overwrite the oldest byte (advance head).
			s.ring[s.ringHead] = b
			s.ringHead = (s.ringHead + 1) % cap
		} else {
			tail := (s.ringHead + s.ringSize) % cap
			s.ring[tail] = b
			s.ringSize++
		}
	}
}

// ringSnapshot copies the current ring contents into a flat byte slice and
// resets the ring to empty.  Returns nil when the ring is empty.
// Caller must hold ringMu.
func (s *session) ringSnapshotLocked() []byte {
	if s.ringSize == 0 || s.ring == nil {
		return nil
	}
	cap := len(s.ring)
	out := make([]byte, s.ringSize)
	for i := 0; i < s.ringSize; i++ {
		out[i] = s.ring[(s.ringHead+i)%cap]
	}
	s.ringHead = 0
	s.ringSize = 0
	return out
}

// SessionList returns metadata for every live PTY session.  The client calls
// this after reattach to discover which tabs survived the dialer absence and
// to decide which ones to call pty.replay on.
func (s *Service) SessionList(_ context.Context, raw json.RawMessage) (any, error) {
	var p SessionListParams
	// params are optional; ignore parse failure (empty params = list all)
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

// Replay sends the ring buffer contents for a session to the current dialer,
// going through the existing ack-credit gate so the dialer is not flooded.
//
// Ordering guarantee: while replay is draining the snapshot, any live PTY
// bytes produced by readLoop are written to the ring (via replayActive flag)
// rather than emitted directly.  After the snapshot drain, those queued live
// bytes are emitted in a second pass.  The result is strictly
// buffered-output → live-output with no interleaving.
func (s *Service) Replay(_ context.Context, raw json.RawMessage) (any, error) {
	var p ReplayParams
	if err := decodeParams(raw, &p, "pty.replay params must include workspaceId and tabId"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "pty.replay")
	if err != nil {
		return nil, err
	}
	sess := s.lookup(key)
	if sess == nil {
		return struct{}{}, nil
	}

	sess.replayMu.Lock()
	defer sess.replayMu.Unlock()

	// Phase 1: signal readLoop to divert live bytes to ring, then snapshot the
	// current ring so the drain below does not race with new PTY output.
	sess.replayActive.Store(1)
	sess.ringMu.Lock()
	snapshot := sess.ringSnapshotLocked()
	sess.ringMu.Unlock()

	// Emit the snapshot in MaxChunkSize chunks through the ack-credit gate.
	// This is the same path as a normal readLoop emit, so the renderer's
	// backpressure is honoured — no unbounded drain.
	if err := s.emitBytes(sess, snapshot); err != nil {
		// Dialer disappeared again mid-replay — push the snapshot back to ring
		// and let the next replay pick it up.
		sess.ringMu.Lock()
		if sess.ring != nil {
			// Prepend snapshot before any bytes written during Phase 1.
			live := sess.ringSnapshotLocked()
			combined := append(snapshot, live...)
			for _, b := range combined {
				cap := len(sess.ring)
				if sess.ringSize == cap {
					sess.ring[sess.ringHead] = b
					sess.ringHead = (sess.ringHead + 1) % cap
				} else {
					tail := (sess.ringHead + sess.ringSize) % cap
					sess.ring[tail] = b
					sess.ringSize++
				}
			}
		}
		sess.ringMu.Unlock()
		sess.replayActive.Store(0)
		return nil, err
	}

	// Phase 2: clear replayActive, then drain bytes queued by readLoop during
	// Phase 1.  Holding ringMu across the flag clear and snapshot prevents a
	// new byte from slipping between the snapshot and the flag clear.
	sess.ringMu.Lock()
	sess.replayActive.Store(0)
	queued := sess.ringSnapshotLocked()
	sess.ringMu.Unlock()

	if err := s.emitBytes(sess, queued); err != nil {
		// Dialer gone again; save queued bytes for next replay.
		if queued != nil {
			sess.ringMu.Lock()
			for _, b := range queued {
				cap := len(sess.ring)
				if sess.ring != nil {
					if sess.ringSize == cap {
						sess.ring[sess.ringHead] = b
						sess.ringHead = (sess.ringHead + 1) % cap
					} else {
						tail := (sess.ringHead + sess.ringSize) % cap
						sess.ring[tail] = b
						sess.ringSize++
					}
				}
			}
			sess.ringMu.Unlock()
		}
		return nil, err
	}

	// After all buffered and queued live bytes have been flushed, send a
	// SIGWINCH wiggle (rows-1 → hold → original) to force a full TUI repaint.
	// This repairs the blank-screen symptom seen when in-flight zombie-window
	// bytes were lost: the ring contains only post-loss output, so the TUI's
	// internal state may be ahead of what was replayed.  SIGWINCH causes
	// full-screen TUIs (claude, vim, tmux, etc.) to redraw themselves entirely,
	// making the terminal immediately usable without requiring user input.
	// Started after the live flush so repaint output lands after replay data;
	// run as a goroutine because the wiggle now holds the shrunken size for
	// wiggleRestoreDelay and must not stall the replay RPC response.
	go sess.wiggleSIGWINCH()

	return struct{}{}, nil
}

// emitBytes sends raw bytes in MaxChunkSize chunks through the ack-credit gate,
// exactly as readLoop does for live output.  Stops and returns the first emit
// error — the caller decides what to do with any un-sent tail.
func (s *Service) emitBytes(sess *session, data []byte) error {
	for len(data) > 0 {
		if !sess.waitForOutputWindow() {
			return errors.New("session stopped")
		}
		n := len(data)
		if n > MaxChunkSize {
			n = MaxChunkSize
		}
		chunk := data[:n]
		data = data[n:]
		sess.noteEmitted(len(chunk))
		if err := s.emit(EventData, DataPayload{
			WorkspaceID: sess.key.workspaceID,
			TabID:       sess.key.tabID,
			Chunk:       base64.StdEncoding.EncodeToString(chunk),
		}); err != nil {
			sess.ack(len(chunk)) // undo debt on failure
			return err
		}
	}
	return nil
}

// emit writes one event through the configured sink, if any.
func (s *Service) emit(event string, payload any) error {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink(event, payload)
}

// timeAfter exists so tests can verify timeout behavior without exposing timers.
func timeAfter(duration time.Duration) <-chan time.Time {
	return time.After(duration)
}
