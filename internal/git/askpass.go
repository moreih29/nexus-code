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
	// askpassRunEnv carries the run id of the request whose git started the
	// helper, so its prompts can be routed to and failed with that request.
	askpassRunEnv = "NEXUS_AGENT_ASKPASS_RUN"
)

type askpassRequestPayload struct {
	RequestID string `json:"requestId"`
	Prompt    string `json:"prompt"`
	RunID     string `json:"runId,omitempty"`
}

type askpassRespondParams struct {
	RequestID string `json:"requestId"`
	Secret    string `json:"secret"`
	// Cancelled fails the helper so Git stops, instead of trying Secret.
	Cancelled bool `json:"cancelled,omitempty"`
}

type askpassHelperRequest struct {
	Prompt string `json:"prompt"`
	RunID  string `json:"runId,omitempty"`
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

// askpassPending is one prompt waiting for the host's answer.
type askpassPending struct {
	resolution chan askpassResolution
	runID      string
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

	if params.Cancelled {
		pending.resolution <- askpassResolution{ok: false, err: "credential prompt cancelled"}
	} else {
		pending.resolution <- askpassResolution{ok: true, secret: params.Secret}
	}
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
	_, runActive := s.streams[request.RunID]
	if request.RunID == "" || runActive {
		s.askpassPending[requestID] = &askpassPending{resolution: resolution, runID: request.RunID}
	}
	s.mu.Unlock()
	if !runActive && request.RunID != "" {
		// The request already ended (or was cancelled) and its prompts were
		// failed; nobody is left to answer this one.
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "git command ended"})
		return
	}
	if sink == nil {
		s.deleteAskpassPending(requestID)
		writeAskpassHelperResponse(conn, askpassHelperResponse{OK: false, Error: "askpass unavailable"})
		return
	}
	if err := sink(askpassRequestEvent, askpassRequestPayload{RequestID: requestID, Prompt: request.Prompt, RunID: request.RunID}); err != nil {
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

// failAskpassRun fails the prompts a request left unanswered when it ended.
// A cancelled git leaves its helper orphaned and blocked on the answer;
// failing the prompt lets it exit.
func (s *Service) failAskpassRun(runID string) {
	s.mu.Lock()
	var ended []*askpassPending
	for requestID, pending := range s.askpassPending {
		if pending.runID == runID {
			delete(s.askpassPending, requestID)
			ended = append(ended, pending)
		}
	}
	s.mu.Unlock()
	for _, pending := range ended {
		pending.resolution <- askpassResolution{ok: false, err: "git command ended"}
	}
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
		pending.resolution <- askpassResolution{ok: false, err: "askpass stopped"}
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

	request := askpassHelperRequest{Prompt: prompt, RunID: os.Getenv(askpassRunEnv)}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
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
