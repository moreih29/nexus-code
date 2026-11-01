// Package stdioserver — shutdown and concurrent-write tests.
//
// drainAndExit stops taking new requests and exits once in-flight handlers
// finish, or after forceExitAfter when one is stuck: a congested pipe must
// not keep the agent from shutting down. WriteFrame must keep each frame
// whole when 1,000 handlers write at once.
package stdioserver

import (
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestDrainAndExitAcceptsNoNewWorkAfterTermination covers the clean path:
// with no handler in flight, drainAndExit stops accepting new requests and
// hands its code to the exit func the daemon installs with SetExitFunc.
func TestDrainAndExitAcceptsNoNewWorkAfterTermination(t *testing.T) {
	host := New(dispatch.New(), io.NopCloser(strings_reader("")), io.Discard, slog.Default())
	exited := make(chan int, 1)
	host.SetExitFunc(func(code int) { exited <- code })

	host.drainAndExit(3)
	select {
	case code := <-exited:
		if code != 3 {
			t.Fatalf("exit code = %d, want 3", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exit func was not called")
	}
	if host.isAccepting() {
		t.Error("host still accepts new requests after drainAndExit")
	}
}

// TestWriteFrameWithPendingGoroutines verifies that 1,000 concurrent
// WriteFrame calls on a non-blocking writer complete without data races or
// frame corruption. Each frame must be a complete, valid NDJSON line.
func TestWriteFrameWithPendingGoroutines(t *testing.T) {
	const pendingHandlers = 1_000

	d := dispatch.New()
	var buf safeBuffer
	host := New(d, io.NopCloser(strings_reader("")), &buf, slog.Default())

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

// When a handler outlives the drain deadline, both the force timer and the
// select's own deadline fire. The exit func must still run once — the
// daemon's closes a channel and panics on a second call — and the host
// context must be cancelled so the stuck handler can unwind.
func TestDrainAndExitCallsExitOnceWhenHandlerIsStuck(t *testing.T) {
	host := New(dispatch.New(), io.NopCloser(strings_reader("")), io.Discard, slog.Default())
	var exits atomic.Int32
	exited := make(chan struct{})
	host.SetExitFunc(func(int) {
		if exits.Add(1) == 1 {
			close(exited)
		}
	})

	host.wg.Add(1) // a handler that never finishes
	defer host.wg.Done()

	host.drainAndExit(0)
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("exit func was not called")
	}
	time.Sleep(4 * forceExitAfter) // let any second timer fire
	if n := exits.Load(); n != 1 {
		t.Fatalf("exit func called %d times, want 1", n)
	}
	if host.ctx.Err() == nil {
		t.Fatal("host context not cancelled on forced exit")
	}
}
