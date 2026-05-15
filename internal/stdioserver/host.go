// Package stdioserver runs the NDJSON request/response loop that the
// agent binary exposes over its stdin/stdout. Boot wiring (argv
// parsing, fs registration, ready frame) belongs to the calling
// `cmd/agent/main.go`; everything past that — request scanning,
// goroutine dispatch, response serialization, signal handling, drain —
// lives here so the binary's entry point stays a thin assembler.
//
// The loop is deliberately concurrent: every request line spawns a
// handler goroutine so a slow file read does not block subsequent
// requests. Responses are serialized through a single stdout mutex,
// and SIGTERM triggers a bounded drain — in-flight handlers get a
// short window to write their final frames before the process exits.
package stdioserver

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// forceExitAfter caps how long SIGTERM will wait for in-flight handlers
// to flush. 75ms matches the test timeout in main_test.go's drain
// assertion and is short enough that a stuck handler cannot keep the
// process alive past the parent's expected shutdown window.
const forceExitAfter = 75 * time.Millisecond

// Host owns the stdio NDJSON server lifecycle. One Host per process —
// stdin / stdout are not multiplexable, and the SIGTERM handler is a
// process-global side effect.
type Host struct {
	dispatcher *dispatch.Dispatcher
	in         io.Reader
	out        io.Writer

	outMu sync.Mutex     // serializes response frames on `out`
	wg    sync.WaitGroup // tracks in-flight handler goroutines

	ctx    context.Context
	cancel context.CancelFunc

	termOnce  sync.Once // ensures drainAndExit fires at most once
	accepting bool      // accept new requests until SIGTERM flips this
	acceptMu  sync.Mutex
}

// New constructs a Host bound to the given dispatcher and stdio streams.
// Tests inject pipe-backed streams; production passes os.Stdin / os.Stdout.
func New(d *dispatch.Dispatcher, in io.Reader, out io.Writer) *Host {
	ctx, cancel := context.WithCancel(context.Background())
	return &Host{
		dispatcher: d,
		in:         in,
		out:        out,
		ctx:        ctx,
		cancel:     cancel,
		accepting:  true,
	}
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
// concurrency, which is bounded by the client request rate. SIGTERM
// triggers a 75 ms force-exit ceiling so no stuck goroutine can prevent
// orderly shutdown.
func (h *Host) WriteFrame(frame any) error {
	data, err := proto.MarshalFrame(frame)
	if err != nil {
		return err
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	_, err = h.out.Write(data)
	return err
}

// EmitEvent writes one server-push event frame. Domain services use this for
// workspace notifications that are not direct responses to one request.
func (h *Host) EmitEvent(event string, payload any) error {
	return h.WriteFrame(proto.Event(event, payload))
}

// Run consumes NDJSON request lines from `in` until EOF or a fatal
// scanner error, dispatching each on its own goroutine. Run does not
// return — it terminates the process via drainAndExit. Install the
// SIGTERM handler via InstallSigtermHandler before calling this so
// the parent's shutdown signal is honored.
func (h *Host) Run() {
	scanner := bufio.NewScanner(h.in)
	// 4 MiB cap matches the largest request shape we expect (writeFile
	// content up to MaxReadableFileSize plus envelope overhead).
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		// Copy the slice — scanner reuses its internal buffer between
		// calls and the line escapes into a goroutine below.
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 || !h.isAccepting() {
			continue
		}
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			h.handleLine(line)
		}()
	}

	if err := scanner.Err(); err != nil {
		// We have no request id to correlate scanner errors with, so
		// emit a sentinel id and let the client treat it as a
		// transport-level protocol failure.
		_ = h.WriteFrame(proto.ProtocolFailure(proto.ProtocolErrorID, err.Error()))
	}
	h.drainAndExit(0)
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

// handleLine parses one NDJSON line, dispatches the request, and writes
// the resulting response. Parse failures are reported with the best id
// recoverable from the raw bytes so the client can still correlate.
func (h *Host) handleLine(line []byte) {
	req, err := proto.ParseRequest(line)
	if err != nil {
		id := proto.IDFromParsedFrame(line)
		if id == "" {
			id = proto.IDFromMalformedLine(string(line))
		}
		if id == "" {
			id = proto.ProtocolErrorID
		}
		_ = h.WriteFrame(proto.ProtocolFailure(id, protocolMessage(err)))
		return
	}
	_ = h.WriteFrame(h.dispatcher.Dispatch(h.ctx, req))
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
// in-flight handlers to flush, then exits. termOnce guarantees that a
// race between EOF and SIGTERM cannot enter this path twice.
func (h *Host) drainAndExit(code int) {
	h.termOnce.Do(func() {
		h.acceptMu.Lock()
		h.accepting = false
		h.acceptMu.Unlock()

		// AfterFunc + a select on the same deadline gives us "exit
		// even if Wait() itself blocks", which Wait can do when a
		// handler is stuck in a syscall.
		forceExit := time.AfterFunc(forceExitAfter, func() { os.Exit(code) })
		done := make(chan struct{})
		go func() {
			h.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
			forceExit.Stop()
		case <-time.After(forceExitAfter):
			os.Exit(code)
		}
		h.cancel()
		os.Exit(code)
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
