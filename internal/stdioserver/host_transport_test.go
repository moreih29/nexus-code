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
	"errors"
	"io"
	"log/slog"
	"strings"
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
