package stdioserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

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

func TestRunExitsNonZeroOnTransportError(t *testing.T) {
	host, exited := newRunHost(errReader{err: errors.New("read tcp: connection reset by peer")})

	go host.Run()

	select {
	case code := <-exited:
		if code != TransportErrorExitCode {
			t.Fatalf("exit code = %d, want %d (transport reset must trigger client reconnect)", code, TransportErrorExitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit within 2s of a transport read error")
	}
}

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

type repeatReader byte

func (r repeatReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(r)
	}
	return len(p), nil
}

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

func TestDispatchRejectsOverloadWithoutQueuingAck(t *testing.T) {
	in, writer := io.Pipe()
	defer writer.Close()
	out, replies := io.Pipe()
	defer out.Close()
	defer replies.Close()
	d := dispatch.New()
	release := make(chan struct{})
	defer close(release)
	acked := make(chan struct{})
	d.RegisterOrdered("slow", func(ctx context.Context, _ json.RawMessage) (any, error) {
		select {
		case <-release:
			return nil, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	d.Register("pty.ack", func(context.Context, json.RawMessage) (any, error) {
		close(acked)
		return nil, nil
	})
	host := New(d, in, replies, slog.New(slog.NewTextHandler(io.Discard, nil)))
	host.SetExitFunc(func(int) {})
	go host.Run()
	go func() {
		var frames strings.Builder
		for i := 0; i < 128; i++ {
			fmt.Fprintf(&frames, "{\"id\":\"%d\",\"method\":\"slow\"}\n", i)
		}
		frames.WriteString("{\"id\":\"overload\",\"method\":\"slow\"}\n{\"id\":\"ack\",\"method\":\"pty.ack\"}\n")
		_, _ = io.WriteString(writer, frames.String())
	}()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-acked:
	case <-timer.C:
		t.Fatal("ACK stalled behind regular requests")
	}
	got := make(chan proto.Response, 1)
	go func() {
		reader := json.NewDecoder(out)
		for range 2 {
			var response proto.Response
			if reader.Decode(&response) != nil {
				return
			}
			if response.ID == "overload" {
				got <- response
				return
			}
		}
	}()
	select {
	case response := <-got:
		if response.Error == nil || response.Error.Code != proto.CodeUnavailable {
			t.Fatalf("overload response = %+v", response)
		}
	case <-timer.C:
		t.Fatal("overload did not produce a rejection")
	}
}
