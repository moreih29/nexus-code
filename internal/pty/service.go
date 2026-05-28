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

// session owns one child process, its master PTY, and per-tab flow control.
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
}

// New constructs an empty PTY service registry.
func New() *Service {
	return &Service{sessions: make(map[tabKey]*session)}
}

// Register binds every pty.* method onto the dispatcher.
func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("pty.spawn", service.Spawn)
	d.Register("pty.write", service.Write)
	d.Register("pty.resize", service.Resize)
	d.Register("pty.ack", service.Ack)
	d.Register("pty.kill", service.Kill)
	d.Register("pty.foregroundProcess", service.ForegroundProcess)
}

// SetEventSink wires the service to the stdio host after both are constructed.
func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
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

// newSession links process state with its flow-control condition variable.
func newSession(service *Service, key tabKey, cmd *exec.Cmd, master *os.File) *session {
	session := &session{service: service, key: key, cmd: cmd, master: master, readDone: make(chan struct{})}
	session.flowCond = sync.NewCond(&session.flowMu)
	return session
}

// readLoop serially emits PTY data, applying renderer-credit backpressure before each read.
func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, MaxChunkSize)
	for {
		if !s.waitForOutputWindow() {
			return
		}
		n, err := s.master.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.noteEmitted(len(chunk))
			if emitErr := s.service.emit(EventData, DataPayload{WorkspaceID: s.key.workspaceID, TabID: s.key.tabID, Chunk: base64.StdEncoding.EncodeToString(chunk)}); emitErr != nil {
				s.stop(syscall.SIGKILL)
				return
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

// removeSession deletes key only if it still points at expected.
func (s *Service) removeSession(key tabKey, expected *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[key] == expected {
		delete(s.sessions, key)
	}
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
