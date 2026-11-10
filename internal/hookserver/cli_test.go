package hookserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
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

// With no app to hand the request to, the client hears so at once instead
// of waiting out the deadline.
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

// A client that goes before main answers, as one stopped with Ctrl-C, is
// told to main as a cli.cancel event for its request; main's late answer
// then has nowhere to go.
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

// A request main never answers is answered with an error at the deadline.
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

// A CLI request with the wrong token is dropped like a hook's.
func TestCLIRequestWithWrongTokenIsDropped(t *testing.T) {
	var called atomic.Bool
	srv := newTestServer(t, func(string, any) error {
		called.Store(true)
		return nil
	})
	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest("wrong"))
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := bufio.NewReader(conn).ReadByte(); err == nil {
		t.Fatal("the server answered a request with the wrong token")
	}
	if called.Load() {
		t.Fatal("the request reached main")
	}
}
