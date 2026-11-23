package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestChatStdinInterruptsAnInFlightWrite(t *testing.T) {
	writer, reader, err := newChatStdin(fmt.Sprintf("%d-test-stdin", os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	defer reader.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type outcome struct {
		n   int
		err error
	}
	data := bytes.Repeat([]byte("x"), 4<<20)
	done := make(chan outcome, 1)
	go func() {
		n, err := writer.WriteContext(ctx, data)
		done <- outcome{n, err}
	}()
	read := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(reader, make([]byte, 1))
		read <- err
	}()
	select {
	case err := <-read:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("child stdin did not receive the first byte")
	}
	cancel()
	select {
	case got := <-done:
		if !errors.Is(got.err, context.Canceled) || got.n <= 0 || got.n >= len(data) {
			t.Fatalf("interrupted pipe returned %d, %v", got.n, got.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled writer waited for the child to read again")
	}
}

type blockedFrame struct {
	entered chan struct{}
	written int
	closed  bool
}

func (w *blockedFrame) Close() error {
	w.closed = true
	return nil
}

func (w *blockedFrame) WriteContext(ctx context.Context, data []byte) (int, error) {
	if w.closed {
		return 0, io.ErrClosedPipe
	}
	if w.entered != nil {
		close(w.entered)
		w.entered = nil
		<-ctx.Done()
		return w.written, ctx.Err()
	}
	return len(data), nil
}

func TestCanceledStdinFrameOnlyClosesAfterAPartialWrite(t *testing.T) {
	for _, tc := range []struct {
		name    string
		written int
		code    string
	}{
		{"no bytes", 0, "chat.stdin-write-failed"},
		{"partial", 1, "chat.stdin-incomplete"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			sess, err := s.sessionFor(tabKey{WorkspaceID: "ws", TabID: "tab"}, "")
			if err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			writer := &blockedFrame{entered: entered, written: tc.written}
			sess.proc = &process{stdin: writer}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() {
				_, err := s.Send(ctx, json.RawMessage(`{"workspaceId":"ws","tabId":"tab","message":{"method":"initialize"}}`))
				result <- err
			}()
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("send did not reach stdin")
			}
			cancel()
			select {
			case err := <-result:
				var wireErr proto.CodedError
				if !errors.As(err, &wireErr) || wireErr.Code != tc.code || writer.closed != (tc.written > 0) {
					t.Fatalf("send result %v, pipe closed: %t", err, writer.closed)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("send did not observe cancellation")
			}
			if sess.proc.codexInitialized {
				t.Fatal("an unwritten initialize was recorded as delivered")
			}
			if tc.written == 0 {
				if err := send(t, s, "tab", "next frame"); err != nil {
					t.Fatalf("unwritten cancellation prevented a later send: %v", err)
				}
			}
		})
	}
}
