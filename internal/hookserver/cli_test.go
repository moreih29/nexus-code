package hookserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func readCLIResponse(t *testing.T, conn net.Conn) cliWireResponse {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatalf("no response: %v", scanner.Err())
	}
	var resp cliWireResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return resp
}

func cliRequest(token string) hookWireRequest {
	return hookWireRequest{
		Type:        "cli",
		Token:       token,
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Payload:     json.RawMessage(`{"argv":["status"],"cwd":"/w","tempDir":"/tmp"}`),
	}
}

func TestCLIRequestWithoutAppFailsAtOnce(t *testing.T) {
	for name, sink := range map[string]EventSink{
		"no sink":      nil,
		"sink refuses": func(string, any) error { return errors.New("no dialer") },
	} {
		t.Run(name, func(t *testing.T) {
			srv := newTestServer(t, sink)
			conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(srv.Token()))
			defer conn.Close()
			resp := readCLIResponse(t, conn)
			if resp.OK || resp.Error != "NexusCode is not connected" {
				t.Fatalf("response = %+v", resp)
			}
		})
	}
}

func TestCLIClientGoneIsToldToMain(t *testing.T) {
	events := make(chan struct {
		name    string
		payload any
	}, 2)
	srv := newTestServer(t, func(name string, payload any) error {
		events <- struct {
			name    string
			payload any
		}{name, payload}
		return nil
	})

	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(srv.Token()))
	first := <-events
	requestID := first.payload.(CLIEventPayload).RequestID
	conn.Close()

	select {
	case got := <-events:
		cancel, ok := got.payload.(CLICancelPayload)
		if got.name != "cli.cancel" || !ok {
			t.Fatalf("event %q %+v", got.name, got.payload)
		}
		if cancel.RequestID != requestID || cancel.WorkspaceID != "ws-1" {
			t.Fatalf("cancel = %+v", cancel)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no cli.cancel after the client went")
	}
	if err := srv.RespondCLI(requestID, json.RawMessage(`{}`)); err == nil {
		t.Fatal("an answer to a cancelled request was taken")
	}
}

type missedCloseConn struct {
	net.Conn
	deadline  chan struct{}
	peerGone  chan struct{}
	stop      chan struct{}
	armed     sync.Once
	firstRead bool
}

func (c *missedCloseConn) SetReadDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		c.armed.Do(func() { close(c.deadline) })
	}
	return nil
}

func (c *missedCloseConn) Read(p []byte) (int, error) {
	if c.firstRead {
		return c.Conn.Read(p)
	}
	c.firstRead = true
	<-c.peerGone
	select {
	case <-c.deadline:
		return 0, os.ErrDeadlineExceeded
	case <-c.stop:
		return 0, net.ErrClosed
	}
}

func TestCLIClientGoneAfterMissedRead(t *testing.T) {
	requests := make(chan CLIEventPayload, 1)
	cancels := make(chan CLICancelPayload, 1)
	srv := newTestServer(t, func(_ string, payload any) error {
		switch event := payload.(type) {
		case CLIEventPayload:
			requests <- event
		case CLICancelPayload:
			cancels <- event
		}
		return nil
	})
	server, client := net.Pipe()
	conn := &missedCloseConn{Conn: server, deadline: make(chan struct{}), peerGone: make(chan struct{}), stop: make(chan struct{})}
	defer server.Close()
	defer close(conn.stop)
	srv.handleCLI(conn, cliRequest(srv.Token()), false)
	request := <-requests
	_ = client.Close()
	close(conn.peerGone)
	select {
	case event := <-cancels:
		if event.RequestID != request.RequestID {
			t.Fatalf("cancel = %+v, want request %s", event, request.RequestID)
		}
	case <-time.After(time.Second):
		t.Fatal("CLI cancellation was lost when the read missed the disconnect")
	}
}

func TestCLIRequestTimesOut(t *testing.T) {
	srv := newTestServer(t, func(string, any) error { return nil })
	srv.testDeadlineNs.Store(int64(100 * time.Millisecond))
	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(srv.Token()))
	defer conn.Close()
	resp := readCLIResponse(t, conn)
	if resp.OK || resp.Error != "NexusCode did not answer" {
		t.Fatalf("response = %+v", resp)
	}
}

func TestCLIRequestWithWrongTokenIsRefused(t *testing.T) {
	var called atomic.Bool
	srv := newTestServer(t, func(string, any) error {
		called.Store(true)
		return nil
	})
	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest("wrong"))
	defer conn.Close()
	if resp := readCLIResponse(t, conn); resp.OK || resp.Error != refusedCLI {
		t.Fatalf("response = %+v", resp)
	}
	if called.Load() {
		t.Fatal("the request reached main")
	}
}
