// Package stdioserver — transport-close classification tests.
//
// Run() must distinguish a clean stdin EOF (the client deliberately closed the
// channel → exit 0, no client reconnect) from a non-EOF scanner error (the SSH
// channel carrying stdin was reset mid-stream → exit non-zero so the client
// reconnects). Before this distinction existed, every drop — including a
// transient network reset — exited 0 and the client treated it as an
// intentional shutdown, leaving the workspace permanently disconnected.
package stdioserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// errReader returns a non-EOF error on the first Read, simulating an SSH
// channel reset mid-stream (as opposed to bufio.Scanner's clean-EOF path,
// which surfaces as Err() == nil).
type errReader struct{ err error }

func (r errReader) Read(p []byte) (int, error) { return 0, r.err }

func newRunHost(in io.Reader) (*Host, chan int) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	host := New(dispatch.New(), in, io.Discard, logger)
	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}
	return host, exited
}

// A non-EOF inbound read error must exit transportErrorExitCode so the client's
// handleClose reconnects instead of treating the dropped link as clean.
func TestRunExitsNonZeroOnTransportError(t *testing.T) {
	host, exited := newRunHost(errReader{err: errors.New("read tcp: connection reset by peer")})

	go host.Run()

	select {
	case code := <-exited:
		if code != transportErrorExitCode {
			t.Fatalf("exit code = %d, want %d (transport reset must trigger client reconnect)", code, transportErrorExitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit within 2s of a transport read error")
	}
}

// A clean EOF (client deliberately closed stdin) must exit 0 so the client
// treats it as an intentional shutdown with no reconnect.
func TestRunExitsZeroOnCleanEOF(t *testing.T) {
	host, exited := newRunHost(strings.NewReader(""))

	go host.Run()

	select {
	case code := <-exited:
		if code != 0 {
			t.Fatalf("exit code = %d, want 0 (clean EOF must not trigger reconnect)", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit within 2s of clean EOF")
	}
}

// repeatReader yields the same byte forever; wrapped in io.LimitReader it
// builds a huge request line without holding it in memory.
type repeatReader byte

func (r repeatReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(r)
	}
	return len(p), nil
}

// syncBuffer is a bytes.Buffer safe for concurrent handler writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// A request line over the 64 MiB cap used to fail the scanner with
// ErrTooLong, which took the transport-error exit — in daemon mode that
// SIGKILLs every PTY. The line must be discarded, answered with an error
// when its id is readable, and the requests after it still served.
func TestRunDiscardsOversizedLineAndKeepsServing(t *testing.T) {
	huge := func(prefix, suffix string) io.Reader {
		return io.MultiReader(
			strings.NewReader(prefix),
			io.LimitReader(repeatReader('x'), maxLineBytes+1),
			strings.NewReader(suffix+"\n"),
		)
	}
	in := io.MultiReader(
		huge(`{"id":"big","method":"ping","params":"`, `"}`),
		strings.NewReader(`{"id":"after-1","method":"ping"}`+"\n"),
		// No recoverable id: params come first and would only mislead.
		huge(`{"params":{"id":"not-me","blob":"`, `"},"id":"x","method":"ping"}`),
		strings.NewReader(`{"id":"after-2","method":"ping"}`+"\n"),
	)
	d := dispatch.New()
	d.Register("ping", func(context.Context, json.RawMessage) (any, error) { return "pong", nil })
	out := &syncBuffer{}
	host := New(d, in, out, slog.New(slog.NewTextHandler(io.Discard, nil)))
	exited := make(chan int, 1)
	host.exit = func(code int) { exited <- code }

	go host.Run()

	select {
	case code := <-exited:
		if code != 0 {
			t.Fatalf("exit code = %d, want 0 (an oversized line must not end the session)", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Run did not finish")
	}
	byID := map[string]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var frame map[string]any
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("bad frame %q: %v", line, err)
		}
		id, _ := frame["id"].(string)
		byID[id] = frame
	}
	if len(byID) != 3 {
		t.Fatalf("want responses for big, after-1 and after-2 only; got %v", byID)
	}
	if byID["big"]["error"] == nil {
		t.Fatalf("oversized request was not answered with an error: %v", byID["big"])
	}
	for _, id := range []string{"after-1", "after-2"} {
		if byID[id]["result"] != "pong" {
			t.Fatalf("%s not served after an oversized line: %v", id, byID[id])
		}
	}
}

func TestLineReaderMatchesScanLines(t *testing.T) {
	lr := lineReader{r: bufio.NewReaderSize(strings.NewReader("a\r\n\n0123456789ab\nb\nc"), 16), max: 8}
	type got struct {
		line    string
		tooLong bool
	}
	var lines []got
	for {
		line, tooLong, err := lr.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, got{string(line), tooLong})
	}
	want := []got{{"a", false}, {"", false}, {"0123456789ab", true}, {"b", false}, {"c", false}}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %#v, want %#v", lines, want)
	}
}
