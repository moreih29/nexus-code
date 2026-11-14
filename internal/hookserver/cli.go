package hookserver

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
)

// The nexus CLI reaches the app through the same socket as Claude Code's
// hooks: `agent cli <args>` sends one "cli" frame, the server hands it to
// main as a "cli.request" event, and main's answer comes back through the
// "cli.respond" method. A command may wait on the app for a long time, as
// `nexus terminal wait` does, so a CLI connection lives longer than a hook's.
// A client that goes before the answer, as one stopped with Ctrl-C, is told
// to main as a "cli.cancel" event, so the command can stop as well.

// cliDeadline is the longest a CLI request waits for main's answer. It is
// longer than the longest wait a command accepts, so the command's own
// timeout answers first.
const cliDeadline = 35 * time.Minute

// CLIEventPayload is the "cli.request" event main receives. Field names
// match CliRequestSchema in src/shared/cli/protocol.ts.
type CLIEventPayload struct {
	RequestID   string          `json:"requestId"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Request     json.RawMessage `json:"request"`
	// Verified says the request came with its tab's token (see TabToken):
	// it is that tab's. Without, it came with the server's own, which any
	// process of the workspace's tabs an older app started may hold: whose
	// it is cannot be told.
	Verified bool `json:"verified"`
}

// CLICancelPayload is the "cli.cancel" event main receives when a request's
// client has gone. Field names match CliCancelSchema in
// src/shared/cli/protocol.ts.
type CLICancelPayload struct {
	RequestID   string `json:"requestId"`
	WorkspaceID string `json:"workspaceId"`
}

// cliWireResponse is the frame the CLI client reads back. Result is main's
// answer as it gave it; Error says why there is none.
type cliWireResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// handleCLI passes one CLI request to main and keeps the connection open
// until main answers, the deadline passes or the server closes.
func (s *Server) handleCLI(conn net.Conn, req hookWireRequest, verified bool) {
	requestID, err := newHookID()
	if err != nil {
		_ = writeNDJSON(conn, cliWireResponse{Error: "request id generation failed"})
		conn.Close()
		return
	}

	s.sinkMu.Lock()
	sink := s.sink
	s.sinkMu.Unlock()
	if sink == nil {
		_ = writeNDJSON(conn, cliWireResponse{Error: "NexusCode is not connected"})
		conn.Close()
		return
	}

	_ = conn.SetDeadline(time.Time{})
	s.cliInflight.Store(requestID, conn)
	payload := CLIEventPayload{
		RequestID:   requestID,
		WorkspaceID: req.WorkspaceID,
		TabID:       req.TabID,
		Request:     req.Payload,
		Verified:    verified,
	}
	if err := sink("cli.request", payload); err != nil {
		if val, ok := s.cliInflight.LoadAndDelete(requestID); ok {
			c := val.(net.Conn)
			_ = writeNDJSON(c, cliWireResponse{Error: "NexusCode is not connected"})
			c.Close()
		}
		return
	}

	go func() {
		// The client sends nothing after its frame, so the read ends only
		// when it goes away or the answer closes the connection.
		_, _ = io.Copy(io.Discard, conn)
		if val, ok := s.cliInflight.LoadAndDelete(requestID); ok {
			val.(net.Conn).Close()
			_ = sink("cli.cancel", CLICancelPayload{RequestID: requestID, WorkspaceID: req.WorkspaceID})
		}
	}()

	deadline := s.cliDeadline()
	go func() {
		timer := time.NewTimer(deadline)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-s.done:
		}
		if val, ok := s.cliInflight.LoadAndDelete(requestID); ok {
			c := val.(net.Conn)
			_ = writeNDJSON(c, cliWireResponse{Error: "NexusCode did not answer"})
			c.Close()
		}
	}()
}

// RespondCLI writes main's answer to the CLI request and closes its
// connection.
func (s *Server) RespondCLI(requestID string, result json.RawMessage) error {
	val, ok := s.cliInflight.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("hookserver: cli request %q not found", requestID)
	}
	conn := val.(net.Conn)
	err := writeNDJSON(conn, cliWireResponse{OK: true, Result: result})
	conn.Close()
	return err
}

// closeCLI answers every CLI request still waiting when the server closes.
func (s *Server) closeCLI() {
	s.cliInflight.Range(func(key, val any) bool {
		s.cliInflight.Delete(key)
		conn := val.(net.Conn)
		_ = writeNDJSON(conn, cliWireResponse{Error: "NexusCode is not connected"})
		conn.Close()
		return true
	})
}

func (s *Server) cliDeadline() time.Duration {
	if ns := s.testDeadlineNs.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return cliDeadline
}
