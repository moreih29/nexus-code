package hookserver

import (
	"encoding/json"
	"fmt"
	"net"
	"time"
)

const cliDeadline = 35 * time.Minute

type CLIEventPayload struct {
	RequestID   string          `json:"requestId"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Request     json.RawMessage `json:"request"`
	Verified    bool            `json:"verified"`
}

type CLICancelPayload struct {
	RequestID   string `json:"requestId"`
	WorkspaceID string `json:"workspaceId"`
}

type cliWireResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

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
	request := s.storeRequest(&s.cliInflight, requestID, conn)
	if request == nil {
		return
	}
	payload := CLIEventPayload{
		RequestID:   requestID,
		WorkspaceID: req.WorkspaceID,
		TabID:       req.TabID,
		Request:     req.Payload,
		Verified:    verified,
	}
	if err := sink("cli.request", payload); err != nil {
		if c, ok := takeRequest(&s.cliInflight, requestID); ok {
			_ = writeNDJSON(c, cliWireResponse{Error: "NexusCode is not connected"})
			c.Close()
		}
		return
	}

	go func() {
		waitForClientGone(conn)
		if c, ok := takeRequest(&s.cliInflight, requestID); ok {
			c.Close()
			_ = sink("cli.cancel", CLICancelPayload{RequestID: requestID, WorkspaceID: req.WorkspaceID})
		}
	}()

	deadline := s.cliDeadline()
	go func() {
		expires, stop := s.newTimer(deadline)
		defer stop()
		select {
		case <-expires:
		case <-s.done:
		case <-request.done:
			return
		}
		if c, ok := takeRequest(&s.cliInflight, requestID); ok {
			_ = writeNDJSON(c, cliWireResponse{Error: "NexusCode did not answer"})
			c.Close()
		}
	}()
}

func (s *Server) RespondCLI(requestID string, result json.RawMessage) error {
	conn, ok := takeRequest(&s.cliInflight, requestID)
	if !ok {
		return fmt.Errorf("hookserver: cli request %q not found", requestID)
	}
	err := writeNDJSON(conn, cliWireResponse{OK: true, Result: result})
	conn.Close()
	return err
}

func (s *Server) closeCLI() {
	s.cliInflight.Range(func(key, _ any) bool {
		if conn, ok := takeRequest(&s.cliInflight, key.(string)); ok {
			_ = writeNDJSON(conn, cliWireResponse{Error: "NexusCode is not connected"})
			conn.Close()
		}
		return true
	})
}

func (s *Server) cliDeadline() time.Duration {
	if ns := s.testDeadlineNs.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return cliDeadline
}
