package hookserver

import (
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"
)

type replyDeadlineConn struct {
	net.Conn
	deadline time.Time
}

func (c *replyDeadlineConn) SetWriteDeadline(deadline time.Time) error {
	c.deadline = deadline
	return c.Conn.SetWriteDeadline(time.Now())
}

func TestReplyDeadlineBoundsBlockedHookAndCLI(t *testing.T) {
	for _, kind := range []string{"hook", "cli"} {
		t.Run(kind, func(t *testing.T) {
			server, client := net.Pipe()
			defer server.Close()
			defer client.Close()
			conn := &replyDeadlineConn{Conn: server}
			s := &Server{}
			if kind == "hook" {
				s.storeRequest(&s.inflight, "reply", conn)
			} else {
				s.storeRequest(&s.cliInflight, "reply", conn)
			}
			started := time.Now()
			result := make(chan error, 1)
			go func() {
				if kind == "hook" {
					result <- s.Respond("reply", HookResponse{Stdout: "answer"})
				} else {
					result <- s.RespondCLI("reply", json.RawMessage(`{"answer":true}`))
				}
			}()
			select {
			case err := <-result:
				var timeout net.Error
				if !errors.As(err, &timeout) || !timeout.Timeout() {
					t.Fatalf("blocked client reply returned %v", err)
				}
				if conn.deadline.Before(started.Add(10*time.Second)) || conn.deadline.After(time.Now().Add(10*time.Second)) {
					t.Fatalf("write deadline was %v", conn.deadline)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("reply is stuck behind a client that never reads")
			}
		})
	}
}
