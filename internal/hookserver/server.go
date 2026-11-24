package hookserver

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const connDeadline = 120 * time.Second

const permissionDeadline = time.Hour

const permissionRequestSubcmd = "permission-request"

const printWatchSubcmd = "print-watch"

const goneRecheck = 500 * time.Millisecond

const maxRequestBytes = proto.MaxHookRequestBytes

type EventSink func(name string, payload any) error

type HookEventPayload struct {
	HookID        string          `json:"hookId"`
	WorkspaceID   string          `json:"workspaceId"`
	TabID         string          `json:"tabId"`
	Subcommand    string          `json:"subcommand"`
	Payload       json.RawMessage `json:"payload"`
	AssistantText string          `json:"assistantText,omitempty"`
	AgentMessages json.RawMessage `json:"agentMessages,omitempty"`
	Print         bool            `json:"print,omitempty"`
}

type HookGonePayload struct {
	HookID      string          `json:"hookId"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Subcommand  string          `json:"subcommand"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

type HookResponse struct {
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

type hookWireRequest struct {
	Type          string          `json:"type"`
	Token         string          `json:"token"`
	WorkspaceID   string          `json:"workspaceId"`
	TabID         string          `json:"tabId"`
	Subcommand    string          `json:"subcommand"`
	Payload       json.RawMessage `json:"payload"`
	AssistantText string          `json:"assistantText,omitempty"`
	AgentMessages json.RawMessage `json:"agentMessages,omitempty"`
	Print         bool            `json:"print,omitempty"`
}

type hookWireResponse struct {
	OK       bool   `json:"ok"`
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

type pendingRequest struct {
	conn net.Conn
	done chan struct{}
}

func (s *Server) storeRequest(requests *sync.Map, id string, conn net.Conn) *pendingRequest {
	request := &pendingRequest{conn: conn, done: make(chan struct{})}
	requests.Store(id, request)
	select {
	case <-s.done:
		if c, ok := takeRequest(requests, id); ok {
			_ = c.Close()
		}
		return nil
	default:
		return request
	}
}

func takeRequest(requests *sync.Map, id string) (net.Conn, bool) {
	value, ok := requests.LoadAndDelete(id)
	if !ok {
		return nil, false
	}
	request := value.(*pendingRequest)
	close(request.done)
	return request.conn, true
}

type Server struct {
	socketPath string
	freshDir   string
	token      string
	listener   net.Listener

	sinkMu sync.Mutex
	sink   EventSink

	inflight    sync.Map
	cliInflight sync.Map
	handshakes  sync.Map

	closeOnce sync.Once
	done      chan struct{}
	newTimer  func(time.Duration) (<-chan time.Time, func())

	readyCh   chan struct{}
	readyOnce sync.Once

	testDeadlineNs atomic.Int64
}

func New(agentKey string, sink EventSink) (*Server, error) {
	return newServer(agentKey, sink, func(delay time.Duration) (<-chan time.Time, func()) {
		timer := time.NewTimer(delay)
		return timer.C, func() { timer.Stop() }
	})
}

func newServer(agentKey string, sink EventSink, newTimer func(time.Duration) (<-chan time.Time, func())) (*Server, error) {
	socketPath, socketsDir, private, err := makeSocketPath(agentKey)
	if err != nil {
		return nil, fmt.Errorf("hookserver: %w", err)
	}

	token, err := newToken()
	if err != nil {
		return nil, fmt.Errorf("hookserver: token generation failed: %w", err)
	}

	ensureDir := agentpaths.EnsureDir
	if private {
		ensureDir = agentpaths.EnsurePrivateDir
	}
	freshDir := ""
	if err := ensureDir(socketsDir); err != nil {
		if !private || !errors.Is(err, agentpaths.ErrNotPrivate) {
			return nil, fmt.Errorf("hookserver: %w", err)
		}
		name := filepath.Base(socketPath)
		fresh, freshErr := agentpaths.FreshPrivateSocketDir(name)
		if errors.Is(freshErr, errors.ErrUnsupported) {
			return nil, fmt.Errorf("hookserver: %w", err)
		}
		if freshErr != nil {
			return nil, fmt.Errorf("hookserver: %w", errors.Join(err, freshErr))
		}
		socketsDir, socketPath, freshDir = fresh, filepath.Join(fresh, name), fresh
	}
	removeFreshDir := func() {
		if freshDir != "" {
			_ = os.Remove(freshDir)
		}
	}

	cleanStaleSockets(socketsDir, filepath.Base(socketPath), time.Now())

	_ = os.Remove(socketPath)

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		removeFreshDir()
		return nil, fmt.Errorf("hookserver: listen failed: %w", err)
	}

	if err := os.Chmod(socketPath, 0600); err != nil {
		_ = ln.Close()
		_ = os.Remove(socketPath)
		removeFreshDir()
		return nil, fmt.Errorf("hookserver: chmod failed: %w", err)
	}

	s := &Server{
		socketPath: socketPath,
		freshDir:   freshDir,
		token:      token,
		listener:   ln,
		sink:       sink,
		done:       make(chan struct{}),
		readyCh:    make(chan struct{}),
		newTimer:   newTimer,
	}

	s.readyOnce.Do(func() { close(s.readyCh) })

	go s.acceptLoop()
	return s, nil
}

func (s *Server) SocketPath() string { return s.socketPath }

func (s *Server) Token() string { return s.token }

func (s *Server) WaitReady(ctx context.Context) error {
	select {
	case <-s.readyCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) SetEventSink(sink EventSink) {
	s.sinkMu.Lock()
	defer s.sinkMu.Unlock()
	s.sink = sink
}

func (s *Server) Respond(hookID string, response HookResponse) error {
	conn, ok := takeRequest(&s.inflight, hookID)
	if !ok {
		return fmt.Errorf("hookserver: hookId %q not found in inflight map", hookID)
	}
	resp := hookWireResponse{
		OK:       true,
		Stdout:   response.Stdout,
		ExitCode: response.ExitCode,
	}
	err := writeNDJSON(conn, resp)
	conn.Close()
	return err
}

func (s *Server) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		close(s.done)

		closeErr = s.listener.Close()

		s.ReleaseHooks()
		s.closeCLI()
		s.handshakes.Range(func(key, _ any) bool {
			_ = key.(net.Conn).Close()
			return true
		})

		_ = os.Remove(s.socketPath)
		if s.freshDir != "" {
			_ = os.Remove(s.freshDir)
		}
	})
	return closeErr
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.done:
			default:
			}
			return
		}
		go s.handleConn(conn)
	}
}

func (s *Server) handleConn(conn net.Conn) {
	s.handshakes.Store(conn, struct{}{})
	defer s.handshakes.Delete(conn)
	select {
	case <-s.done:
		_ = conn.Close()
		return
	default:
	}

	_ = conn.SetDeadline(time.Now().Add(s.connDeadline()))

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRequestBytes)
	if !scanner.Scan() {
		if errors.Is(scanner.Err(), bufio.ErrTooLong) {
			fmt.Fprintf(os.Stderr, "hookserver: request over %d bytes dropped\n", maxRequestBytes)
			_ = writeNDJSON(conn, hookWireResponse{OK: true})
		}
		conn.Close()
		return
	}

	var req hookWireRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		conn.Close()
		return
	}

	kind := s.tokenOf(req)
	if kind == tokenRefused {
		if req.Type == "cli" {
			_ = writeNDJSON(conn, cliWireResponse{Error: refusedCLI})
		}
		conn.Close()
		return
	}
	if req.Type == "cli" {
		s.handleCLI(conn, req, kind == tokenTab)
		return
	}

	hookID, err := newHookID()
	if err != nil {
		_ = writeNDJSON(conn, hookWireResponse{OK: false, Error: "hookId generation failed"})
		conn.Close()
		return
	}
	request := s.storeRequest(&s.inflight, hookID, conn)
	if request == nil {
		return
	}

	_ = conn.SetDeadline(time.Time{})

	s.sinkMu.Lock()
	sink := s.sink
	s.sinkMu.Unlock()

	payload := HookEventPayload{
		HookID:        hookID,
		WorkspaceID:   req.WorkspaceID,
		TabID:         req.TabID,
		Subcommand:    req.Subcommand,
		Payload:       req.Payload,
		AssistantText: req.AssistantText,
		AgentMessages: req.AgentMessages,
		Print:         req.Print,
	}
	delivered := false
	if sink != nil {
		if err := sink("claude.hook", payload); err != nil {
			fmt.Fprintf(os.Stderr, "hookserver: sink error for hookId %s: %v\n", hookID, err)
		} else {
			delivered = true
		}
	}
	if !delivered {
		s.respondDefault(hookID)
		return
	}

	if req.Subcommand == printWatchSubcmd {
		go s.watchGone(hookID, conn, req)
		return
	}
	if req.Subcommand == permissionRequestSubcmd {
		go s.watchGone(hookID, conn, req)
	}

	deadline := s.deadlineFor(req.Subcommand)
	go func() {
		expires, stop := s.newTimer(deadline)
		defer stop()
		select {
		case <-expires:
		case <-s.done:
		case <-request.done:
			return
		}
		s.respondDefault(hookID)
	}()
}

func (s *Server) watchGone(hookID string, conn net.Conn, req hookWireRequest) {
	waitForClientGone(conn)
	if _, waiting := takeRequest(&s.inflight, hookID); !waiting {
		return
	}
	conn.Close()
	s.sinkMu.Lock()
	sink := s.sink
	s.sinkMu.Unlock()
	if sink == nil {
		return
	}
	gone := HookGonePayload{
		HookID:      hookID,
		WorkspaceID: req.WorkspaceID,
		TabID:       req.TabID,
		Subcommand:  req.Subcommand,
	}
	if req.Subcommand == printWatchSubcmd {
		gone.Payload = req.Payload
	}
	if err := sink("claude.hookGone", gone); err != nil {
		fmt.Fprintf(os.Stderr, "hookserver: sink error for gone hookId %s: %v\n", hookID, err)
	}
}

func waitForClientGone(conn net.Conn) {
	var b [1]byte
	for {
		_ = conn.SetReadDeadline(time.Now().Add(goneRecheck))
		if _, err := conn.Read(b[:]); err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
			return
		}
	}
}

func (s *Server) ReleaseHooks() {
	s.inflight.Range(func(key, _ any) bool {
		s.respondDefault(key.(string))
		return true
	})
}

func (s *Server) respondDefault(hookID string) {
	if c, ok := takeRequest(&s.inflight, hookID); ok {
		_ = writeNDJSON(c, hookWireResponse{OK: true})
		c.Close()
	}
}

func (s *Server) connDeadline() time.Duration {
	if ns := s.testDeadlineNs.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return connDeadline
}

func (s *Server) deadlineFor(subcommand string) time.Duration {
	if ns := s.testDeadlineNs.Load(); ns > 0 {
		return time.Duration(ns)
	}
	if subcommand == permissionRequestSubcmd {
		return permissionDeadline
	}
	return connDeadline
}

func makeSocketPath(agentKey string) (socketPath, socketsDir string, private bool, err error) {
	preferred, err := agentpaths.SocketsDir()
	if err != nil {
		return "", "", false, err
	}
	h := sha256.Sum256([]byte(agentKey))
	name := "h-" + hex.EncodeToString(h[:])[:12] + ".sock"
	socketsDir, private, err = agentpaths.SocketDir(preferred, name)
	if err != nil {
		return "", "", false, err
	}
	return filepath.Join(socketsDir, name), socketsDir, private, nil
}

func cleanStaleSockets(socketsDir, selfBasename string, now time.Time) {
	entries, err := os.ReadDir(socketsDir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		name := entry.Name()

		matched, err := filepath.Match("h-*.sock", name)
		if err != nil || !matched {
			continue
		}

		if name == selfBasename {
			continue
		}

		fullPath := filepath.Join(socketsDir, name)

		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < 60*time.Second {
			continue
		}

		conn, err := net.DialTimeout("unix", fullPath, 500*time.Millisecond)
		if err == nil {
			conn.Close()
			continue
		}

		if !isConnRefused(err) {
			continue
		}

		_ = os.Remove(fullPath)
	}
}

func AgentKey(rootPath string) string {
	return rootPath + "\x00" + strconv.Itoa(os.Getpid())
}

func newToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func newHookID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

const replyWriteTimeout = 10 * time.Second

func writeNDJSON(conn net.Conn, v any) error {
	data, err := proto.MarshalFrame(v)
	if err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(replyWriteTimeout)); err != nil {
		return err
	}
	_, err = conn.Write(data)
	return err
}
