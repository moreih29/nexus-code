package pty

import (
	"bytes"
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
// ring buffer that keeps its most recent output for pty.replay.
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

	// ring is the fixed-capacity circular buffer holding the session's most
	// recent output, whether or not a dialer received it, so pty.replay can
	// redraw the screen for a client that has none of it.  ringMu serializes
	// all reads/writes to ring*.
	ringMu      sync.Mutex
	ring        []byte
	ringHead    int  // index of the oldest byte in ring
	ringSize    int  // number of valid bytes currently stored
	ringDropped bool // whether older output has been overwritten

	// outputMu orders output on the wire.  readLoop holds it to record and emit
	// one chunk; pty.replay holds it for the whole replay, so live output waits
	// behind the replayed output instead of interleaving with it.
	outputMu sync.Mutex

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
	// change.  Production code leaves it nil (setWinsize is used).
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
		// The session outlived its previous client (an app restart or a window
		// reload).  Fit it to the new client, which replays it to redraw the
		// screen.  Best-effort: a session that is exiting reports exit anyway.
		_ = existing.resize(p.Cols, p.Rows)
		return SpawnResult{PID: existing.cmd.Process.Pid, Attached: true}, nil
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
	// From here on the master must not go through os.File.Fd(): that would
	// put it back into blocking mode (see pollableMaster and withFd).
	master = pollableMaster(master)

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
	if err := session.resize(p.Cols, p.Rows); err != nil {
		return nil, requestFailed("failed to resize PTY: %s", err)
	}
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
	var pgid int
	ioErr := withFd(session.master, func(fd int) (err error) {
		pgid, err = unix.IoctlGetInt(fd, unix.TIOCGPGRP)
		return err
	})
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
func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, MaxChunkSize)
	for {
		if !s.waitForOutputWindow() {
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

// deliver records one chunk of PTY output in the ring and emits it.  When the
// dialer is gone the chunk is kept only in the ring, for a reattaching dialer to
// recover through pty.replay; the PTY child is NOT killed and keeps running
// until the reattach grace expires.
func (s *session) deliver(chunk []byte) {
	s.outputMu.Lock()
	defer s.outputMu.Unlock()
	s.ringAppend(chunk)
	s.noteEmitted(len(chunk))
	if err := s.service.emit(EventData, DataPayload{WorkspaceID: s.key.workspaceID, TabID: s.key.tabID, Chunk: base64.StdEncoding.EncodeToString(chunk)}); err != nil {
		// Undo the renderer debt — there is no renderer to send acks, so leaving
		// the debt would permanently pause readLoop on the next
		// waitForOutputWindow check once a dialer reconnects.
		s.ack(len(chunk))
	}
}

// resize applies a PTY geometry and records it for wiggleSIGWINCH.
func (s *session) resize(cols int, rows int) error {
	if err := setWinsize(s.master, &creackpty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		return err
	}
	s.sizeMu.Lock()
	s.lastCols = cols
	s.lastRows = rows
	s.sizeMu.Unlock()
	return nil
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
	setSize := setWinsize
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

// setWinsize applies ws to the PTY master. It replaces creackpty.Setsize,
// which reaches the descriptor through os.File.Fd(): that read is not
// synchronized with a concurrent Close (a data race, and an ioctl on a
// possibly reused descriptor number), which resize and the post-replay
// wiggle hit whenever the session is torn down at the same time.
func setWinsize(master *os.File, ws *creackpty.Winsize) error {
	return withFd(master, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Row: ws.Rows, Col: ws.Cols, Xpixel: ws.X, Ypixel: ws.Y})
	})
}

// withFd runs fn with the master's descriptor held open: SyscallConn's
// Control keeps the file from being closed underneath fn and fails cleanly
// once it has been closed, unlike os.File.Fd().
func withFd(master *os.File, fn func(fd int) error) error {
	conn, err := master.SyscallConn()
	if err != nil {
		return err
	}
	var fnErr error
	if err := conn.Control(func(fd uintptr) { fnErr = fn(int(fd)) }); err != nil {
		return err
	}
	return fnErr
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
			// The write ran over the oldest bytes: advance head past them.
			s.ringHead = (s.ringHead + s.ringSize - cap) % cap
			s.ringSize = cap
			s.ringDropped = true
		}
	}
}

// ringContentsLocked copies the ring contents, oldest first, into a flat byte
// slice.  Once older output has been dropped, the oldest byte may sit in the
// middle of an escape sequence or a multi-byte character, so the copy starts
// after the first line break instead.  Caller must hold ringMu.
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

// Replay redraws a session's screen for the current dialer, which may have
// none of its output: one reattaching after an outage, or a restarted app
// attaching to a session that kept running.  It sends a terminal reset and the
// retained output, marked as replay, through the ack-credit gate so the dialer
// is not flooded.
//
// Ordering guarantee: Replay holds outputMu for the whole send, so live PTY
// output read meanwhile waits in readLoop and follows the replayed output on
// the wire with no interleaving.
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

	sess.outputMu.Lock()
	sess.ringMu.Lock()
	replay := append([]byte(terminalReset), sess.ringContentsLocked()...)
	sess.ringMu.Unlock()
	err = s.emitReplay(sess, replay)
	sess.outputMu.Unlock()
	if err != nil {
		// Dialer disappeared again mid-replay; the ring still holds everything
		// for the next replay.
		return nil, err
	}

	// The retained output may not reproduce the program's current screen: the
	// ring may have dropped the start of it, and a full-screen program's state
	// can be ahead of what was replayed.  A SIGWINCH wiggle (rows-1 → hold →
	// original) makes full-screen TUIs (claude, vim, tmux, etc.) redraw
	// themselves entirely, making the terminal immediately usable without
	// requiring user input.  Started after the replay so repaint output lands
	// after it; run as a goroutine because the wiggle holds the shrunken size
	// for wiggleRestoreDelay and must not stall the replay RPC response.
	go sess.wiggleSIGWINCH()

	return struct{}{}, nil
}

// emitReplay sends replayed bytes in MaxChunkSize chunks through the
// ack-credit gate, exactly as readLoop does for live output.  Stops and
// returns the first emit error.
func (s *Service) emitReplay(sess *session, data []byte) error {
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
			Replay:      true,
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
