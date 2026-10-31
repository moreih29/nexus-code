package hookserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
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

// A CLI request reaches main as a cli.request event, and main's answer
// reaches the client as it was given.
func TestCLIRequestGetsMainsAnswer(t *testing.T) {
	var mu sync.Mutex
	var events []CLIEventPayload
	got := make(chan struct{}, 1)
	srv := newTestServer(t, func(name string, payload any) error {
		if name != "cli.request" {
			t.Errorf("event %q", name)
		}
		mu.Lock()
		events = append(events, payload.(CLIEventPayload))
		mu.Unlock()
		got <- struct{}{}
		return nil
	})

	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(srv.Token()))
	defer conn.Close()
	<-got

	mu.Lock()
	event := events[0]
	mu.Unlock()
	if event.WorkspaceID != "ws-1" || event.TabID != "tab-1" {
		t.Fatalf("event = %+v", event)
	}
	if string(event.Request) != `{"argv":["status"],"cwd":"/w","tempDir":"/tmp"}` {
		t.Fatalf("request = %s", event.Request)
	}

	answer := json.RawMessage(`{"stdout":"ok\n","stderr":"","exitCode":0}`)
	if err := srv.RespondCLI(event.RequestID, answer); err != nil {
		t.Fatalf("RespondCLI: %v", err)
	}
	resp := readCLIResponse(t, conn)
	if !resp.OK || string(resp.Result) != string(answer) {
		t.Fatalf("response = %+v", resp)
	}
	if err := srv.RespondCLI(event.RequestID, answer); err == nil {
		t.Fatal("a second answer to the same request was taken")
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
