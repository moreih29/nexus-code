package git

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	askpassRequestEvent = "git.askpass.request"
	askpassSocketEnv    = "NEXUS_AGENT_ASKPASS_SOCKET"
	askpassModeEnv      = "NEXUS_AGENT_ASKPASS_MODE"
)

type askpassRequestPayload struct {
	RequestID string `json:"requestId"`
	Prompt    string `json:"prompt"`
}

type askpassRespondParams struct {
	RequestID string `json:"requestId"`
	Secret    string `json:"secret"`
}

type askpassHelperRequest struct {
	Prompt string `json:"prompt"`
}

type askpassHelperResponse struct {
	OK    bool   `json:"ok"`
	Value string `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

type askpassResolution struct {
	secret string
	ok     bool
	err    string
}

// RespondAskpass resolves one credential prompt that was emitted by the agent
// host askpass socket. The secret is delivered only to the waiting helper
// process and is never logged or included in returned errors.
func (s *Service) RespondAskpass(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var params askpassRespondParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return nil, proto.ProtocolError("git.askpass.respond params must include requestId and secret")
	}
	if strings.TrimSpace(params.RequestID) == "" || strings.Contains(params.RequestID, "\x00") {
		return nil, proto.ProtocolError("git.askpass.respond requestId is required")
	}
	if strings.Contains(params.Secret, "\x00") {
		return nil, proto.ProtocolError("git.askpass.respond secret must not contain NUL")
	}

	s.mu.Lock()
	pending := s.askpassPending[params.RequestID]
	delete(s.askpassPending, params.RequestID)
	s.mu.Unlock()
	if pending == nil {
		return nil, proto.ProtocolError("git.askpass.respond requestId is not active")
	}

	pending <- askpassResolution{ok: true, secret: params.Secret}
	return struct{}{}, nil
}

func (s *Service) ensureAskpassServer() (string, error) {
	s.mu.Lock()
	if s.askpassListener != nil && s.askpassSocketPath != "" {
		path := s.askpassSocketPath
		s.mu.Unlock()
		return path, nil
	}
	s.mu.Unlock()

	dir, err := os.MkdirTemp("", "nexus-agent-askpass-")
	if err != nil {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git askpass helper unavailable"}
	}
	socketPath := filepath.Join(dir, "askpass.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git askpass helper unavailable"}
	}

	s.mu.Lock()
	if s.askpassListener != nil && s.askpassSocketPath != "" {
		path := s.askpassSocketPath
		s.mu.Unlock()
		_ = listener.Close()
		_ = os.RemoveAll(dir)
		return path, nil
	}
	s.askpassListener = listener
	s.askpassSocketDir = dir
	s.askpassSocketPath = socketPath
	s.mu.Unlock()

	go s.serveAskpass(listener)
	return socketPath, nil
}

func (s *Service) serveAskpass(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go s.handleAskpassConn(conn)
	}
}

func (s *Service) handleAskpassConn(conn net.Conn) {
	defer conn.Close()
	var request askpassHelperRequest
	if err := json.NewDecoder(conn).Decode(&request); err != nil {
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "invalid askpass request"})
		return
	}

	requestID, err := newAskpassRequestID()
	if err != nil {
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "askpass unavailable"})
		return
	}
	resolution := make(chan askpassResolution, 1)

	s.mu.Lock()
	sink := s.sink
	s.askpassPending[requestID] = resolution
	s.mu.Unlock()
	if sink == nil {
		s.deleteAskpassPending(requestID)
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "askpass unavailable"})
		return
	}
	if err := sink(askpassRequestEvent, askpassRequestPayload{RequestID: requestID, Prompt: request.Prompt}); err != nil {
		s.deleteAskpassPending(requestID)
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "askpass unavailable"})
		return
	}

	result := <-resolution
	if !result.ok {
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: result.err})
		return
	}
	writeAskpassHelperResponse(conn, askpassHelperResponse{OK: true, Value: result.secret})
}

func (s *Service) deleteAskpassPending(requestID string) {
	s.mu.Lock()
	delete(s.askpassPending, requestID)
	s.mu.Unlock()
}

func (s *Service) closeAskpassServerLocked() {
	if s.askpassListener != nil {
		_ = s.askpassListener.Close()
		s.askpassListener = nil
	}
	if s.askpassSocketDir != "" {
		_ = os.RemoveAll(s.askpassSocketDir)
		s.askpassSocketDir = ""
		s.askpassSocketPath = ""
	}
	for requestID, pending := range s.askpassPending {
		delete(s.askpassPending, requestID)
		pending <- askpassResolution{ok: false, err: "askpass stopped"}
	}
}

func writeAskpassHelperResponse(writer io.Writer, response askpassHelperResponse) {
	_ = json.NewEncoder(writer).Encode(response)
}

func newAskpassRequestID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// RunAskpassHelper is the `agent --askpass <socket>` entrypoint. Git appends
// the prompt text as argv; the helper forwards it to the running agent and
// writes only the resolved secret to stdout.
func RunAskpassHelper(socketPath string, promptArgs []string, stdout io.Writer, stderr io.Writer) int {
	if strings.TrimSpace(socketPath) == "" {
		fmt.Fprintln(stderr, "Nexus Git askpass helper unavailable.")
		return 1
	}
	prompt := strings.Join(promptArgs, " ")
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		fmt.Fprintln(stderr, "Nexus Git askpass helper unavailable.")
		return 1
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(askpassHelperRequest{Prompt: prompt}); err != nil {
		fmt.Fprintln(stderr, "Nexus Git askpass helper failed.")
		return 1
	}
	responseReader := bufio.NewReader(conn)
	var response askpassHelperResponse
	if err := json.NewDecoder(responseReader).Decode(&response); err != nil {
		fmt.Fprintln(stderr, "Nexus Git askpass helper failed.")
		return 1
	}
	if !response.OK {
		fmt.Fprintln(stderr, "Nexus Git askpass helper cancelled.")
		return 1
	}
	if _, err := io.WriteString(stdout, response.Value); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		fmt.Fprintln(stderr, "Nexus Git askpass helper failed.")
		return 1
	}
	return 0
}

func AskpassSocketFromEnv() (string, bool) {
	if os.Getenv(askpassModeEnv) != "1" {
		return "", false
	}
	socketPath := os.Getenv(askpassSocketEnv)
	return socketPath, socketPath != ""
}
