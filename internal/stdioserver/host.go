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
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/fs"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const forceExitAfter = 75 * time.Millisecond

const shutdownHooksGrace = 3 * time.Second

var errOutputClosed = errors.New("stdioserver: output closed")

const IdleWatchdogExitCode = 75

const TransportErrorExitCode = 74

type Host struct {
	dispatcher *dispatch.Dispatcher
	in         io.Reader
	out        io.Writer
	logger     *slog.Logger

	outMu     sync.Mutex
	wg        sync.WaitGroup
	outClosed bool

	orderedMu   sync.Mutex
	orderedTail map[string]chan struct{}

	ctx    context.Context
	cancel context.CancelFunc

	termOnce  sync.Once
	accepting bool
	acceptMu  sync.Mutex
	regular   dispatchUsage
	control   dispatchUsage
	rejected  []string
	rejecting bool

	hooksMu       sync.Mutex
	shutdownHooks []func()

	startMono time.Time

	lastInbound atomic.Int64

	exit func(int)
}

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

func (h *Host) Context() context.Context {
	return h.ctx
}

func (h *Host) stampInbound(now time.Time) {
	h.lastInbound.Store(int64(now.Sub(h.startMono)))
}

func (h *Host) idleElapsed(now time.Time) time.Duration {
	return now.Sub(h.startMono) - time.Duration(h.lastInbound.Load())
}

func (h *Host) WriteFrame(frame any) error {
	data, err := proto.MarshalFrame(frame)
	if err != nil {
		return err
	}
	return h.writeLine(data)
}

func (h *Host) writeLine(data []byte) error {
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if h.outClosed {
		return errOutputClosed
	}
	_, err := h.out.Write(data)
	return err
}

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

func (h *Host) EmitEvent(event string, payload any) error {
	return h.WriteFrame(proto.Event(event, payload))
}

func (h *Host) Run() {
	lines := lineReader{r: bufio.NewReaderSize(h.in, 64*1024), max: maxLineBytes}

	for {
		line, tooLong, err := lines.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = h.WriteFrame(proto.ProtocolFailure(proto.ProtocolErrorID, err.Error()))
			h.drainAndExit(TransportErrorExitCode)
			return
		}
		if len(line) == 0 && !tooLong {
			continue
		}
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
			line = nil
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

const maxLineBytes = 64 * 1024 * 1024

const lineHeadBytes = 4 * 1024

type lineReader struct {
	r   *bufio.Reader
	max int
}

func (lr *lineReader) next() (line []byte, tooLong bool, err error) {
	for {
		chunk, readErr := lr.r.ReadSlice('\n')
		if readErr == nil {
			chunk = chunk[:len(chunk)-1]
		}
		switch {
		case tooLong:
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

func dropCR(line []byte) []byte {
	if len(line) > 0 && line[len(line)-1] == '\r' {
		return line[:len(line)-1]
	}
	return line
}

var requestHead = regexp.MustCompile(`^\s*\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"method"\s*:\s*"((?:[^"\\]|\\.)*)")?`)

func (h *Host) rejectOversizedLine(head []byte) {
	var id, method string
	if match := requestHead.FindSubmatch(head); match != nil {
		id, _ = strconv.Unquote(`"` + string(match[1]) + `"`)
		method = string(match[2])
	}
	h.logger.Warn("discarded inbound line over size limit", "limitBytes", maxLineBytes, "id", id)
	if id != "" {
		message := fmt.Sprintf("Request exceeds the %d MiB line limit.", maxLineBytes>>20)
		if method == "fs.writeFile" {
			_ = h.WriteFrame(oversizedFileFrame(id, message))
		} else {
			_ = h.WriteFrame(proto.ProtocolFailure(id, message))
		}
	}
}

func oversizedFileFrame(id, message string) proto.Response {
	err := fs.FSError{Code: fs.CodeTransferTooLarge, Path: message}
	return proto.Failure(id, err.Code, err.Error())
}

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

func (h *Host) StartIdleWatchdog(limit time.Duration) {
	h.startIdleWatchdog(limit, func(check time.Duration) (<-chan time.Time, func()) {
		ticker := time.NewTicker(check)
		return ticker.C, ticker.Stop
	})
}

func (h *Host) startIdleWatchdog(limit time.Duration, newTicker func(time.Duration) (<-chan time.Time, func())) {
	if limit <= 0 {
		return
	}
	h.stampInbound(time.Now())
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
					h.drainAndExit(IdleWatchdogExitCode)
					return
				}
			case <-h.ctx.Done():
				return
			}
		}
	}()
}

func (h *Host) RegisterShutdownHook(fn func()) {
	if fn == nil {
		return
	}
	h.hooksMu.Lock()
	defer h.hooksMu.Unlock()
	h.shutdownHooks = append(h.shutdownHooks, fn)
}

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

func (h *Host) SetExitFunc(fn func(int)) {
	if fn != nil {
		h.exit = fn
	}
}

func (h *Host) InstallSigtermHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
	go func() {
		<-ch
		h.drainAndExit(0)
	}()
}

func (h *Host) handleRequest(line []byte, req proto.Request, err error) {
	if err != nil {
		_ = h.WriteFrame(proto.ProtocolFailure(requestID(line, req), protocolMessage(err)))
		return
	}

	response := h.dispatcher.Dispatch(h.ctx, req)
	data, err := proto.MarshalFrame(response)
	if err != nil {
		return
	}
	if len(data)-1 > maxLineBytes {
		message := fmt.Sprintf("Response exceeds the %d MiB line limit.", maxLineBytes>>20)
		if strings.HasPrefix(req.Method, "fs.") {
			_ = h.WriteFrame(oversizedFileFrame(req.ID, message))
		} else {
			_ = h.WriteFrame(proto.Failure(req.ID, proto.CodeRequestFailed, message))
		}
		return
	}
	_ = h.writeLine(data)
}

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

func (h *Host) beginRequest(method string, size int) (release func(), accepting bool) {
	h.acceptMu.Lock()
	defer h.acceptMu.Unlock()
	if !h.accepting {
		return nil, false
	}
	usage, countLimit, byteLimit := &h.regular, maxDispatchRequests, maxDispatchBytes
	switch method {
	case "pty.ack", "search.cancel", "git.cancel", "lsp.cancel", "chat.stop", "chat.cancelRun", "lsp.shutdown", "fs.upload.abort":
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

func (h *Host) isAccepting() bool {
	h.acceptMu.Lock()
	defer h.acceptMu.Unlock()
	return h.accepting
}

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

func protocolMessage(err error) string {
	if _, ok := err.(proto.CodedError); ok {
		return err.Error()
	}
	return "malformed JSON"
}
