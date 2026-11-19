// Package stdioserver runs the NDJSON request/response loop that the
// agent binary exposes over its stdin/stdout. Boot wiring (argv
// parsing, fs registration, ready frame) belongs to the calling
// `cmd/agent/main.go`; everything past that — request scanning,
// goroutine dispatch, response serialization, signal handling, drain —
// lives here so the binary's entry point stays a thin assembler.
//
// The loop is deliberately concurrent: every request line spawns a
// handler goroutine so a slow file read does not block subsequent
// requests. Methods the dispatcher marks ordered are the exception:
// their requests run one after another, in arrival order. Responses
// are serialized through a single stdout mutex, and SIGTERM triggers
// a bounded drain — in-flight handlers get a short window to write
// their final frames before the process exits.
package stdioserver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// forceExitAfter caps how long SIGTERM will wait for in-flight handlers
// to flush: short enough that a stuck handler cannot keep the process
// alive past the parent's expected shutdown window.
const forceExitAfter = 75 * time.Millisecond

// shutdownHooksGrace caps how long the shutdown hooks may take once the
// drain is over. They hang up the terminals, which wait up to a second for
// their shells, so it is longer than forceExitAfter; a hung hook still cannot
// keep the process alive past it.
const shutdownHooksGrace = 3 * time.Second

// errOutputClosed is what a frame written after WriteLastFrame fails with.
var errOutputClosed = errors.New("stdioserver: output closed")

// IdleWatchdogExitCode is the process exit code used when the idle watchdog
// reaps the agent. It is deliberately non-zero so the client reconnects rather
// than treating the close as a clean shutdown (see StartIdleWatchdog). 75 is
// EX_TEMPFAIL from sysexits.h — "temporary failure, the user is invited to
// retry" — which matches the intent exactly.
const IdleWatchdogExitCode = 75

// TransportErrorExitCode is the process exit code used when the inbound stdin
// scanner fails with a non-EOF error — i.e. the transport (the SSH channel
// carrying our stdin) was reset or broke mid-stream rather than closing
// cleanly. It is deliberately non-zero so the client's handleClose reconnects
// instead of treating the close as an intentional shutdown: a clean EOF means
// the client deliberately closed the channel (exit 0, no reconnect), whereas a
// read error means the link died under us and an automatic reconnect is the
// desired recovery. 74 is EX_IOERR from sysexits.h — "an error occurred while
// doing I/O on some file" — which names the cause precisely and stays distinct
// from the watchdog's EX_TEMPFAIL (75) in diagnostics.
const TransportErrorExitCode = 74

// Host owns the stdio NDJSON server lifecycle. One Host per process —
// stdin / stdout are not multiplexable, and the SIGTERM handler is a
// process-global side effect.
type Host struct {
	dispatcher *dispatch.Dispatcher
	in         io.Reader
	out        io.Writer
	// logger is the base structured logger for this host. The logger must
	// already have the "src":"agent-log" marker attribute attached (configured
	// in main.go).
	logger *slog.Logger

	outMu sync.Mutex     // serializes response frames on `out`
	wg    sync.WaitGroup // tracks in-flight handler goroutines
	// outClosed is set by WriteLastFrame: nothing is written after it.
	// Guarded by outMu.
	outClosed bool

	// Each queue's tail closes once its last request has been handled.
	orderedMu   sync.Mutex
	orderedTail map[string]chan struct{}

	ctx    context.Context
	cancel context.CancelFunc

	termOnce  sync.Once // ensures drainAndExit fires at most once
	accepting bool      // accept new requests until SIGTERM flips this
	acceptMu  sync.Mutex
	regular   dispatchUsage
	control   dispatchUsage
	rejected  []string
	rejecting bool

	// shutdownHooks are run in order by drainAndExit right before it exits.
	// os.Exit skips defers, so a resource that needs explicit cleanup, such
	// as a socket file, registers a hook. They run even when the drain gave
	// up on a stuck handler; one that has not finished within
	// shutdownHooksGrace is cut off and the process exits anyway.
	hooksMu       sync.Mutex
	shutdownHooks []func()

	// startMono anchors the monotonic clock for idle accounting. lastInbound is
	// stored as a duration relative to this anchor (not a wall-clock UnixNano),
	// so the idle watchdog is immune to wall-clock jumps — NTP steps on the
	// remote, or a laptop waking from sleep with a local agent. time.Since on a
	// Time that carries a monotonic reading (which startMono does) uses the
	// monotonic clock; a bare time.Unix value would silently fall back to wall.
	startMono time.Time

	// lastInbound is time.Since(startMono) in nanoseconds at the most recently
	// received request line, read by the idle watchdog (StartIdleWatchdog) to
	// detect a vanished client. Written from Run's single reader goroutine, read
	// from the watchdog goroutine — atomic keeps that race-free.
	lastInbound atomic.Int64

	// exit terminates the process. Defaults to os.Exit; tests inject a fake so
	// drain/watchdog termination can be observed without killing the runner.
	exit func(int)
}

// New constructs a Host bound to the given dispatcher and stdio streams.
// Tests inject pipe-backed streams; production passes os.Stdin / os.Stdout.
//
// logger must already carry the "src":"agent-log" marker attribute so that
// every log record written through it (or its children) is identifiable as
// structured agent output on the stderr stream.
func New(d *dispatch.Dispatcher, in io.Reader, out io.Writer, logger *slog.Logger) *Host {
	ctx, cancel := context.WithCancel(context.Background())
	return &Host{
		dispatcher:  d,
		in:          in,
		out:         out,
		logger:      logger,
		ctx:         ctx,
		cancel:      cancel,
		accepting:   true,
		orderedTail: make(map[string]chan struct{}),
		exit:        os.Exit,
		startMono:   time.Now(),
	}
}

// Context returns the connection context passed to request handlers. The
// host cancels it once the drain finishes or reaches its deadline.
func (h *Host) Context() context.Context {
	return h.ctx
}

// stampInbound records "now" (monotonic, relative to startMono) as the last
// time an inbound line arrived. Single encoding point for lastInbound so the
// watchdog's idleElapsed reads the same units.
func (h *Host) stampInbound(now time.Time) {
	h.lastInbound.Store(int64(now.Sub(h.startMono)))
}

// idleElapsed reports how long it has been since the last inbound line, using
// the monotonic clock so it cannot be skewed by wall-clock adjustments.
func (h *Host) idleElapsed(now time.Time) time.Duration {
	return now.Sub(h.startMono) - time.Duration(h.lastInbound.Load())
}

// WriteFrame serializes one frame as NDJSON onto `out`. Used by the
// caller to emit the boot Ready frame before Run begins; internal
// response writes use the same path.
//
// The Write call is intentionally blocking: if the transport consumer
// (the main process reading the agent's stdout) is paused for
// backpressure, the goroutine calling WriteFrame will block on the OS
// pipe write. This is the designed transport-level backpressure signal —
// a backed-up pipe propagates naturally into handler goroutine
// concurrency, which is bounded by the connection's dispatch budget. SIGTERM
// triggers a 75 ms force-exit ceiling so no stuck goroutine can prevent
// orderly shutdown.
func (h *Host) WriteFrame(frame any) error {
	data, err := proto.MarshalFrame(frame)
	if err != nil {
		return err
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if h.outClosed {
		return errOutputClosed
	}
	_, err = h.out.Write(data)
	return err
}

// WriteLastFrame writes frame as the last thing the host sends, to a peer
// about to be cut off; later writes fail. A peer that stopped reading holds
// it up for no more than within: when `out` takes a write deadline, as a
// net.Conn does, the deadline cuts short this write and any other write stuck
// on that peer, which would hold it up on outMu.
func (h *Host) WriteLastFrame(frame any, within time.Duration) error {
	data, err := proto.MarshalFrame(frame)
	if err != nil {
		return err
	}
	if out, ok := h.out.(interface{ SetWriteDeadline(time.Time) error }); ok {
		_ = out.SetWriteDeadline(time.Now().Add(within))
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if h.outClosed {
		return errOutputClosed
	}
	h.outClosed = true
	_, err = h.out.Write(data)
	return err
}

// EmitEvent writes one server-push event frame. Domain services use this for
// workspace notifications that are not direct responses to one request.
func (h *Host) EmitEvent(event string, payload any) error {
	return h.WriteFrame(proto.Event(event, payload))
}

// Run consumes NDJSON request lines from `in` until EOF or a fatal
// read error, dispatching each on its own goroutine (ordered methods
// wait for the ordered request before them). Run does not
// return — it terminates the process via drainAndExit. Install the
// SIGTERM handler via InstallSigtermHandler before calling this so
// the parent's shutdown signal is honored.
func (h *Host) Run() {
	lines := lineReader{r: bufio.NewReaderSize(h.in, 64*1024), max: maxLineBytes}

	for {
		// Each line is freshly allocated, so it may escape into the
		// handler goroutine below without a copy.
		line, tooLong, err := lines.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			// A non-EOF read error means the transport broke mid-stream (the
			// SSH channel carrying stdin was reset, not closed cleanly). We
			// have no request id to correlate it with, so emit a sentinel id
			// as a best-effort transport-level protocol failure — it may not
			// reach a client whose link is already gone — then exit non-zero
			// so a still-present client reconnects rather than treating this
			// as a clean shutdown. A clean EOF falls through to exit 0.
			_ = h.WriteFrame(proto.ProtocolFailure(proto.ProtocolErrorID, err.Error()))
			h.drainAndExit(TransportErrorExitCode)
			return
		}
		if len(line) == 0 && !tooLong {
			continue
		}
		// Any inbound line proves the client is alive — reset the idle watchdog.
		h.stampInbound(time.Now())
		if tooLong {
			if h.isAccepting() {
				h.rejectOversizedLine(line)
			}
			continue
		}
		req, parseErr := proto.ParseRequest(line)
		size := len(line)
		finishRequest, accepting := h.beginRequest(req.Method, size)
		if !accepting {
			continue
		}
		if finishRequest == nil {
			if !h.rejectBusy(requestID(line, req)) {
				h.drainAndExit(TransportErrorExitCode)
				return
			}
			continue
		}
		if parseErr == nil {
			line = nil // The parsed envelope owns the data the handler needs.
		}
		var prev <-chan struct{}
		var finish func()
		if key, ordered := h.dispatcher.OrderKey(req); parseErr == nil && ordered {
			prev, finish = h.enqueueOrdered(key)
		}
		go func() {
			defer finishRequest()
			if finish != nil {
				defer finish()
				if prev != nil {
					select {
					case <-prev:
					case <-h.ctx.Done():
						return
					}
				}
			}
			if h.ctx.Err() == nil {
				h.handleRequest(line, req, parseErr)
			}
		}()
	}
	h.drainAndExit(0)
}

// enqueueOrdered appends a request in input order and removes idle queues.
func (h *Host) enqueueOrdered(key string) (<-chan struct{}, func()) {
	h.orderedMu.Lock()
	defer h.orderedMu.Unlock()
	prev := h.orderedTail[key]
	done := make(chan struct{})
	h.orderedTail[key] = done
	return prev, func() {
		h.orderedMu.Lock()
		defer h.orderedMu.Unlock()
		close(done)
		if h.orderedTail[key] == done {
			delete(h.orderedTail, key)
		}
	}
}

// maxLineBytes caps one inbound request line. It matches the largest request
// shape we expect: a writeFile whose content is up to MaxReadableFileSize
// (50 MiB), JSON-escaped, plus envelope overhead. 64 MiB leaves headroom for
// escaping; the line buffer grows lazily up to this ceiling.
const maxLineBytes = 64 * 1024 * 1024

// lineHeadBytes is how much of an oversized line is kept to recover its id.
const lineHeadBytes = 4 * 1024

// lineReader splits input into lines the way bufio.Scanner with ScanLines
// does (a trailing "\r" is dropped, a final unterminated line is returned),
// except that a line longer than max is skipped instead of ending the stream:
// a Scanner fails with ErrTooLong there, which used to take the
// transport-error exit and, in daemon mode, kill every PTY.
type lineReader struct {
	r   *bufio.Reader
	max int
}

// next returns the next line without its line ending. For a line longer than
// max it consumes the whole line and returns tooLong with only the first
// lineHeadBytes. It returns io.EOF once the input is exhausted.
func (lr *lineReader) next() (line []byte, tooLong bool, err error) {
	for {
		chunk, readErr := lr.r.ReadSlice('\n')
		if readErr == nil {
			chunk = chunk[:len(chunk)-1] // the '\n' itself
		}
		switch {
		case tooLong:
			// Already over the limit: discard until the line ends.
		case len(line)+len(chunk) <= lr.max:
			line = append(line, chunk...)
		default:
			tooLong = true
			if len(line) < lineHeadBytes {
				line = append(line, chunk[:min(len(chunk), lineHeadBytes-len(line))]...)
			}
			line = append([]byte(nil), line[:min(len(line), lineHeadBytes)]...)
		}
		switch {
		case readErr == bufio.ErrBufferFull:
			continue
		case readErr == nil:
			return dropCR(line), tooLong, nil
		case readErr == io.EOF && (len(line) > 0 || tooLong):
			return dropCR(line), tooLong, nil
		default:
			return nil, false, readErr
		}
	}
}

// dropCR drops a terminal "\r", as bufio.ScanLines does.
func dropCR(line []byte) []byte {
	if len(line) > 0 && line[len(line)-1] == '\r' {
		return line[:len(line)-1]
	}
	return line
}

// requestIDAtStart matches the id of a request line whose first key is "id",
// which is how the client serializes every request ({id, method, params}).
// Anchoring keeps an "id" inside params from being mistaken for it.
var requestIDAtStart = regexp.MustCompile(`^\s*\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"`)

// rejectOversizedLine answers a request line that exceeded maxLineBytes
// with a protocol error when its id can be read from the line's head, so the
// caller fails fast instead of waiting for its timeout; otherwise it is only
// logged. The connection keeps serving either way.
func (h *Host) rejectOversizedLine(head []byte) {
	id := ""
	if match := requestIDAtStart.FindSubmatch(head); match != nil {
		if unquoted, err := strconv.Unquote(`"` + string(match[1]) + `"`); err == nil {
			id = unquoted
		}
	}
	h.logger.Warn("discarded inbound line over size limit", "limitBytes", maxLineBytes, "id", id)
	if id != "" {
		_ = h.WriteFrame(proto.ProtocolFailure(id, fmt.Sprintf("request exceeds the %d MiB line limit", maxLineBytes>>20)))
	}
}

// StartHeartbeat 는 interval마다 "agent.heartbeat" 이벤트를 emit하는 goroutine을
// 시작한다. interval이 0 이하면 아무것도 하지 않는다(heartbeat 비활성화).
//
// host.Run() 호출 직전에 한 번 불러야 한다 — h.ctx 취소(드레인)가 ticker를 정지한다.
// seq는 atomic counter로 단조 증가하며, uptimeMs는 StartHeartbeat 최초 호출 시점
// 기준 경과 시간(ms)이다.
func (h *Host) StartHeartbeat(interval time.Duration) {
	if interval <= 0 {
		return
	}
	startTime := time.Now()
	var seq atomic.Int64
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				n := seq.Add(1)
				uptime := time.Since(startTime)
				_ = h.EmitEvent("agent.heartbeat", map[string]any{
					"seq":      n,
					"uptimeMs": uptime.Milliseconds(),
				})
			case <-h.ctx.Done():
				return
			}
		}
	}()
}

// StartIdleWatchdog self-terminates the agent (via drainAndExit) when no
// inbound request line arrives within `limit`. This reaps the agent — and,
// through it, every PTY child — when the client has vanished but the SSH
// connection lingers without delivering stdin EOF: a half-open TCP link, a
// hung client process, or a suspended laptop. The client sends a periodic
// `ping` so a healthy but idle session keeps resetting lastInbound; only a
// genuinely absent client trips the limit.
//
// The client pings every limit/6 (it derives that from the idleWatchdogMs the
// agent advertises in its Ready frame), so a healthy session lands ~6 pings per
// window and tolerates several missed ticks before the limit trips — chosen
// because a false fire kills live PTY children, while a slow reap merely lets an
// orphan linger. A non-positive limit disables the watchdog. Call before Run();
// the goroutine stops when h.ctx is cancelled (drain).
func (h *Host) StartIdleWatchdog(limit time.Duration) {
	h.startIdleWatchdog(limit, func(check time.Duration) (<-chan time.Time, func()) {
		ticker := time.NewTicker(check)
		return ticker.C, ticker.Stop
	})
}

// startIdleWatchdog checks elapsed time at each tick of the supplied clock.
func (h *Host) startIdleWatchdog(limit time.Duration, newTicker func(time.Duration) (<-chan time.Time, func())) {
	if limit <= 0 {
		return
	}
	h.stampInbound(time.Now())
	// Check at limit/6 (independent of the old limit/3) so raising the limit
	// keeps the kill window tight: silence trips between limit and limit+limit/6.
	check := limit / 6
	if check <= 0 {
		check = limit
	}
	ticks, stop := newTicker(check)
	go func() {
		defer stop()
		for {
			select {
			case now := <-ticks:
				if h.idleElapsed(now) >= limit {
					// Exit non-zero so the client distinguishes a watchdog reap
					// from a clean shutdown: its handleClose treats code 0 as a
					// terminal exit (no reconnect) but reconnects on any other
					// code. This only reaches a client in the false-positive case
					// (client alive but stalled past the limit) — exactly when an
					// automatic reconnect is the desired recovery. When the client
					// is genuinely gone, no one observes the code.
					h.drainAndExit(IdleWatchdogExitCode)
					return
				}
			case <-h.ctx.Done():
				return
			}
		}
	}()
}

// RegisterShutdownHook adds a cleanup callback that drainAndExit runs, in
// registration order, right before it exits. SIGTERM skips defers, so a
// resource that needs explicit cleanup, such as the hookserver's socket file,
// uses a hook.
//
// A hook that hangs cannot keep the process alive: shutdownHooksGrace bounds
// them. May be called more than once before Run().
func (h *Host) RegisterShutdownHook(fn func()) {
	if fn == nil {
		return
	}
	h.hooksMu.Lock()
	defer h.hooksMu.Unlock()
	h.shutdownHooks = append(h.shutdownHooks, fn)
}

// runShutdownHooks runs the registered cleanup callbacks in order. drainAndExit
// calls it once, after the in-flight handlers drained or it gave up on them,
// right before it exits. A hook's panic is contained so the next hook still
// runs.
func (h *Host) runShutdownHooks() {
	h.hooksMu.Lock()
	hooks := append([]func(){}, h.shutdownHooks...)
	h.hooksMu.Unlock()
	for _, fn := range hooks {
		func() {
			defer func() { _ = recover() }()
			fn()
		}()
	}
}

// SetExitFunc replaces the exit function called by drainAndExit. The default
// is os.Exit. The daemon overrides this so that a dialer leaving — clean EOF
// (0) or a broken connection (TransportErrorExitCode) — ends only this host
// and the daemon keeps running for the next dialer to reattach; the idle
// watchdog (IdleWatchdogExitCode) still ends the daemon. Must be called
// before Run.
func (h *Host) SetExitFunc(fn func(int)) {
	if fn != nil {
		h.exit = fn
	}
}

// InstallSigtermHandler arranges for a single SIGTERM to trigger a
// graceful drain + exit. Safe to call exactly once before Run.
func (h *Host) InstallSigtermHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
	go func() {
		<-ch
		h.drainAndExit(0)
	}()
}

// handleRequest dispatches a parsed request and writes
// the resulting response. Parse failures are reported with the best id
// recoverable from the raw bytes so the client can still correlate.
func (h *Host) handleRequest(line []byte, req proto.Request, err error) {
	if err != nil {
		_ = h.WriteFrame(proto.ProtocolFailure(requestID(line, req), protocolMessage(err)))
		return
	}

	_ = h.WriteFrame(h.dispatcher.Dispatch(h.ctx, req))
}

// Dispatch admits four full desktop reconnect queues or two maximum frames.
// Control traffic gets a separate budget so it can free regular slots.
const (
	maxDispatchRequests = 128
	maxDispatchBytes    = 2 * maxLineBytes
	maxControlRequests  = 32
	maxControlBytes     = 1 << 20
	maxBusyReplies      = 64
	maxBusyIDBytes      = 4 << 10
)

type dispatchUsage struct {
	requests int
	bytes    int
}

// requestID recovers a request's correlation ID even from malformed input.
func requestID(line []byte, req proto.Request) string {
	if req.ID != "" {
		return req.ID
	}
	if id := proto.IDFromParsedFrame(line); id != "" {
		return id
	}
	if id := proto.IDFromMalformedLine(string(line)); id != "" {
		return id
	}
	return proto.ProtocolErrorID
}

// beginRequest reserves a drain slot and the retained line's dispatch budget.
func (h *Host) beginRequest(method string, size int) (release func(), accepting bool) {
	h.acceptMu.Lock()
	defer h.acceptMu.Unlock()
	if !h.accepting {
		return nil, false
	}
	usage, countLimit, byteLimit := &h.regular, maxDispatchRequests, maxDispatchBytes
	switch method {
	case "pty.ack", "search.cancel", "git.cancel", "lsp.cancel", "chat.stop", "lsp.shutdown":
		usage, countLimit, byteLimit = &h.control, maxControlRequests, maxControlBytes
	}
	if usage.requests >= countLimit || size > byteLimit-usage.bytes {
		return nil, true
	}
	usage.requests++
	usage.bytes += size
	h.wg.Add(1)
	return func() {
		h.acceptMu.Lock()
		usage.requests--
		usage.bytes -= size
		h.acceptMu.Unlock()
		h.wg.Done()
	}, true
}

// rejectBusy keeps overload responses off the input loop. If the peer keeps
// sending while refusing to drain the bounded reply queue, Run closes it.
func (h *Host) rejectBusy(id string) bool {
	h.acceptMu.Lock()
	defer h.acceptMu.Unlock()
	if !h.accepting {
		return true
	}
	if len(h.rejected) >= maxBusyReplies || len(id) > maxBusyIDBytes {
		return false
	}
	h.rejected = append(h.rejected, id)
	if !h.rejecting {
		h.rejecting = true
		h.wg.Add(1)
		go h.writeBusyReplies()
	}
	return true
}

// writeBusyReplies writes correlated failures without holding admission locks.
func (h *Host) writeBusyReplies() {
	defer h.wg.Done()
	for {
		h.acceptMu.Lock()
		if len(h.rejected) == 0 {
			h.rejecting = false
			h.acceptMu.Unlock()
			return
		}
		id := h.rejected[0]
		h.rejected[0] = ""
		h.rejected = h.rejected[1:]
		h.acceptMu.Unlock()
		_ = h.WriteFrame(proto.Failure(id, proto.CodeUnavailable, "Agent is busy: dispatch limit exceeded"))
	}
}

// isAccepting reports whether the loop should still spawn handlers.
// Flipped to false during drainAndExit so requests arriving after
// SIGTERM are ignored rather than queued behind in-flight work.
func (h *Host) isAccepting() bool {
	h.acceptMu.Lock()
	defer h.acceptMu.Unlock()
	return h.accepting
}

// drainAndExit stops accepting new work, waits up to forceExitAfter for
// in-flight handlers to flush, runs registered shutdown hooks, then exits.
// termOnce guarantees that a race between EOF and SIGTERM cannot enter
// this path twice, and so that the exit func runs exactly once: the
// daemon's closes a channel, and in daemon mode the process outlives it.
//
// The hooks run after the drain, so cleanup sees no concurrent activity —
// or, when a handler is stuck (on a dead transport, say), after the drain
// gives up on it: they kill the terminals and remove the hook socket, which
// an exit without them leaves behind. shutdownHooksGrace bounds them.
func (h *Host) drainAndExit(code int) {
	h.termOnce.Do(func() {
		h.acceptMu.Lock()
		h.accepting = false
		h.acceptMu.Unlock()

		drained := make(chan struct{})
		go func() {
			h.wg.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-time.After(forceExitAfter):
		}
		// Abort the handlers still stuck on a dead dialer.
		h.cancel()

		hooksDone := make(chan struct{})
		go func() {
			h.runShutdownHooks()
			close(hooksDone)
		}()
		select {
		case <-hooksDone:
		case <-time.After(shutdownHooksGrace):
		}
		h.exit(code)
	})
}

// protocolMessage strips internal Go error verbiage from parse failures
// the client should never see — only proto.CodedError carries a message
// already shaped for the wire. Everything else collapses to a generic
// hint so we don't leak json package internals as protocol output.
func protocolMessage(err error) string {
	if _, ok := err.(proto.CodedError); ok {
		return err.Error()
	}
	return "malformed JSON"
}
