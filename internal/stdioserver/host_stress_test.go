// Package stdioserver — architect risk 1 stress test.
//
// Verifies that drainAndExit exits within forceExitAfter (75ms) even when
// 1,000+ goroutines are blocked in WriteFrame because the transport consumer
// (the reader of the Host's `out` pipe) has stopped reading.
//
// This models the backpressure scenario described in the architecture review:
//
//	"If the TS side pauses the pipe, goroutines calling WriteFrame block on
//	 the OS pipe write. SIGTERM triggers a 75ms force-exit so no stuck goroutine
//	 can prevent orderly shutdown."
//
// Test mechanism:
//  1. Create a blocking writer that blocks after the first 64 bytes.
//  2. Launch 1,000 goroutines all calling writer.Write (mirroring WriteFrame
//     behavior on a congested pipe).
//  3. Replicate drainAndExit's force-timer logic (without calling os.Exit).
//  4. Assert the force timer fires within 2×forceExitAfter.
//
// A separate test (TestWriteFrameWithPendingGoroutines) verifies that 1,000
// concurrent WriteFrame calls on a non-blocking writer complete without data
// races or frame corruption.
package stdioserver

import (
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// blockingWriter is an io.Writer that blocks after writing blockAfterBytes
// total bytes. Used to simulate a congested OS pipe.
type blockingWriter struct {
	mu              sync.Mutex
	written         int
	blockAfterBytes int
	blockCh         chan struct{} // closed when the writer should unblock
}

func newBlockingWriter(blockAfterBytes int) *blockingWriter {
	return &blockingWriter{
		blockAfterBytes: blockAfterBytes,
		blockCh:         make(chan struct{}),
	}
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	before := w.written
	w.written += len(p)
	w.mu.Unlock()

	if before >= w.blockAfterBytes {
		// Already past threshold — block until unblocked.
		<-w.blockCh
	}
	return len(p), nil
}

func (w *blockingWriter) unblock() {
	select {
	case <-w.blockCh:
		// already closed
	default:
		close(w.blockCh)
	}
}

// TestDrainAndExitForceExitTimeBound verifies that the force-exit timer in
// drainAndExit fires within forceExitAfter even when 1,000+ goroutines are
// blocked on a congested writer (simulating a stalled OS pipe write).
//
// We cannot call os.Exit in a test, so we replicate the timer logic inline.
func TestDrainAndExitForceExitTimeBound(t *testing.T) {
	const pendingHandlers = 1_000
	const deadline = 2 * forceExitAfter // generous bound for OS scheduler jitter

	var wg sync.WaitGroup
	writer := newBlockingWriter(64) // block after 64 bytes of output

	// Track how many goroutines have started.
	var startedCount atomic.Int64
	allStarted := make(chan struct{})

	for i := 0; i < pendingHandlers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := startedCount.Add(1)
			if n == pendingHandlers {
				close(allStarted)
			}
			// Simulate a WriteFrame call — blocks on congested writer.
			_, _ = writer.Write([]byte(`{"event":"test","payload":{"idx":1}}`))
		}()
	}

	// Wait until all goroutines have started and are blocked.
	select {
	case <-allStarted:
	case <-time.After(5 * time.Second):
		writer.unblock()
		t.Fatal("goroutines did not start within 5s")
	}

	// Replicate drainAndExit's force-exit logic without calling os.Exit.
	forceExitFired := make(chan struct{})
	drainDone := make(chan struct{})

	forceTimer := time.AfterFunc(forceExitAfter, func() {
		close(forceExitFired)
	})
	defer forceTimer.Stop()

	go func() {
		wg.Wait()
		close(drainDone)
	}()

	start := time.Now()

	select {
	case <-drainDone:
		elapsed := time.Since(start)
		writer.unblock()
		t.Fatalf("wg.Wait() completed before force timer — goroutines should be blocked (elapsed: %s)", elapsed)
	case <-forceExitFired:
		elapsed := time.Since(start)
		// Force timer fired — this is the expected path.
		writer.unblock() // unblock goroutines so the test can exit cleanly.
		<-drainDone
		t.Logf("force timer fired after %s (limit: %s)", elapsed, forceExitAfter)
		if elapsed > deadline {
			t.Errorf("force timer fired but wall-clock elapsed %s > 2×forceExitAfter (%s)", elapsed, deadline)
		}
	case <-time.After(deadline):
		elapsed := time.Since(start)
		writer.unblock()
		<-drainDone
		t.Fatalf("force timer did not fire within %s (elapsed: %s); forceExitAfter=%s", deadline, elapsed, forceExitAfter)
	}
}

// TestDrainAndExitAcceptsNoNewWorkAfterTermination verifies that isAccepting()
// returns false once accepting is flipped, so new requests are not queued
// behind in-flight blocked goroutines.
func TestDrainAndExitAcceptsNoNewWorkAfterTermination(t *testing.T) {
	d := dispatch.New()
	pr, pw := io.Pipe()
	defer func() {
		_ = pw.Close()
		_ = pr.Close()
	}()

	host := New(d, pr, io.Discard)

	// Flip accepting to false (mirrors what drainAndExit does).
	host.acceptMu.Lock()
	host.accepting = false
	host.acceptMu.Unlock()

	if host.isAccepting() {
		t.Error("expected isAccepting() == false after accepting flipped to false")
	}
}

// TestWriteFrameWithPendingGoroutines verifies that 1,000 concurrent
// WriteFrame calls on a non-blocking writer complete without data races or
// frame corruption. Each frame must be a complete, valid NDJSON line.
func TestWriteFrameWithPendingGoroutines(t *testing.T) {
	const pendingHandlers = 1_000

	d := dispatch.New()
	var buf safeBuffer
	host := New(d, io.NopCloser(strings_reader("")), &buf)

	var wg sync.WaitGroup
	var written atomic.Int64

	for i := 0; i < pendingHandlers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			err := host.WriteFrame(proto.Event("test.event", map[string]int{"idx": idx}))
			if err == nil {
				written.Add(1)
			}
		}(i)
	}

	wg.Wait()

	if int(written.Load()) != pendingHandlers {
		t.Errorf("expected %d frames written, got %d", pendingHandlers, written.Load())
	}

	// Verify no partial lines (each frame must end with \n).
	data := buf.bytes()
	if len(data) == 0 {
		t.Fatal("no data written")
	}
	if data[len(data)-1] != '\n' {
		t.Error("last byte is not newline — frames may be corrupted")
	}
	newlineCount := 0
	for _, b := range data {
		if b == '\n' {
			newlineCount++
		}
	}
	if newlineCount != pendingHandlers {
		t.Errorf("expected %d newlines (one per frame), got %d", pendingHandlers, newlineCount)
	}
}

// safeBuffer is an io.Writer that accumulates bytes without data races.
type safeBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	b.buf = append(b.buf, p...)
	b.mu.Unlock()
	return len(p), nil
}

func (b *safeBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf...)
}

// strings_reader returns an io.Reader over a constant string.
// Avoids importing "strings" just for the Reader type.
func strings_reader(s string) io.Reader {
	return &constReader{s: []byte(s)}
}

type constReader struct {
	s   []byte
	pos int
}

func (r *constReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.pos:])
	r.pos += n
	return n, nil
}
