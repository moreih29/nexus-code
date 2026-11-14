package hookserver

import (
	"net"
	"testing"
	"time"
)

// The token is the server's bound to both ids: another tab's, or the same
// ids split another way, make another.
func TestTabTokenIsBoundToTheTab(t *testing.T) {
	token := TabToken("secret", "ws-1", "tab-1")
	if len(token) != 64 {
		t.Fatalf("token = %q", token)
	}
	for _, other := range []string{
		TabToken("secret", "ws-1", "tab-2"),
		TabToken("secret", "ws-2", "tab-1"),
		TabToken("other", "ws-1", "tab-1"),
		TabToken("secret", "ws-1|tab", "-1"),
	} {
		if other == token {
			t.Fatalf("%q made for another tab", other)
		}
	}
	// As main makes it (tests/unit/main/features/workspace/tab-token.test.ts).
	if want := "ca76041e3856d63c1dc1f0a56162bcd253a7666238f246230a2db56792e956f2"; token != want {
		t.Fatalf("token = %q", token)
	}
}

// A request with its tab's token is told to main as that tab's; one with
// the server's own (a terminal an older app started) as one whose tab
// cannot be told; one with another tab's token is refused.
func TestCLIRequestSaysWhetherItsTabIsKnown(t *testing.T) {
	events := make(chan CLIEventPayload, 4)
	srv := newTestServer(t, func(name string, payload any) error {
		if p, ok := payload.(CLIEventPayload); ok && name == "cli.request" {
			events <- p
		}
		return nil
	})
	for _, c := range []struct {
		name     string
		token    string
		verified bool
	}{
		{"tab's token", TabToken(srv.Token(), "ws-1", "tab-1"), true},
		{"server's token", srv.Token(), false},
	} {
		conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(c.token))
		select {
		case got := <-events:
			if got.Verified != c.verified || got.TabID != "tab-1" {
				t.Fatalf("%s: event = %+v", c.name, got)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: no cli.request", c.name)
		}
		conn.Close()
	}

	conn := dialAndSendRequest(t, srv.SocketPath(), cliRequest(TabToken(srv.Token(), "ws-1", "tab-2")))
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("another tab's token was taken")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("another tab's token was not refused")
	}
	select {
	case got := <-events:
		t.Fatalf("refused request told to main: %+v", got)
	default:
	}
}
