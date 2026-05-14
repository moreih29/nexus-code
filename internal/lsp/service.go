package lsp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// Service owns the registry of active LSP server processes.
type Service struct {
	mu      sync.Mutex
	sink    EventSink
	servers map[string]*serverProcess

	nextServerSeq uint64
	nextAgentSeq  uint64
}

// New constructs an empty LSP service registry.
func New() *Service {
	return &Service{servers: make(map[string]*serverProcess)}
}

// Register binds every lsp.* method onto the dispatcher.
func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("lsp.spawn", service.Spawn)
	d.Register("lsp.send", service.Send)
	d.Register("lsp.cancel", service.Cancel)
	d.Register("lsp.shutdown", service.Shutdown)
	d.Register("lsp.respondServerRequest", service.RespondServerRequest)
}

// SetEventSink wires the service to the stdio host after both are constructed.
func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

// Close terminates all active language server processes.
func (s *Service) Close() {
	s.mu.Lock()
	servers := make([]*serverProcess, 0, len(s.servers))
	for id, server := range s.servers {
		servers = append(servers, server)
		delete(s.servers, id)
	}
	s.mu.Unlock()

	for _, server := range servers {
		server.forceClose()
	}
}

func (s *Service) Spawn(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SpawnParams
	if err := decodeParams(raw, &p, "lsp.spawn params must include workspaceId, languageId, binaryPath, args, and workspaceRoot"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.WorkspaceID) == "" {
		return nil, protocolError("lsp.spawn workspaceId is required")
	}
	if strings.TrimSpace(p.LanguageID) == "" {
		return nil, protocolError("lsp.spawn languageId is required")
	}
	if strings.TrimSpace(p.WorkspaceRoot) == "" {
		return nil, protocolError("lsp.spawn workspaceRoot is required")
	}

	binaryPath, err := resolveBinaryPath(p.BinaryPath)
	if err != nil {
		return nil, err
	}
	workspaceRoot, err := filepath.Abs(p.WorkspaceRoot)
	if err != nil {
		return nil, requestFailed("invalid workspaceRoot: %s", err)
	}
	workspaceRoot = filepath.Clean(workspaceRoot)

	idleTimeout := defaultIdleTimeout
	if p.IdleTimeoutMs != nil {
		if *p.IdleTimeoutMs < 0 {
			return nil, protocolError("lsp.spawn idleTimeoutMs must be non-negative")
		}
		if *p.IdleTimeoutMs == 0 {
			idleTimeout = 0
		} else {
			idleTimeout = time.Duration(*p.IdleTimeoutMs) * time.Millisecond
		}
	}

	serverID := s.nextServerID()
	server := newServerProcess(s, serverID, SpawnParams{
		WorkspaceID:   p.WorkspaceID,
		LanguageID:    p.LanguageID,
		BinaryPath:    binaryPath,
		Args:          append([]string(nil), p.Args...),
		WorkspaceRoot: workspaceRoot,
		Capabilities:  p.Capabilities,
	}, idleTimeout)
	s.storeServer(server)

	if err := server.start(ctx); err != nil {
		s.removeServer(serverID, server)
		return nil, err
	}

	// Announce the serverId before initialize runs so the client can
	// route any pre-spawn-resolution server messages (configuration,
	// publishDiagnostics on a workspace open, etc.) by serverId rather
	// than guessing from the order spawns were issued.
	_ = s.emit(EventServerAssigned, ServerAssignedPayload{
		ServerID:      serverID,
		CorrelationID: p.CorrelationID,
	})

	initCtx, cancel := context.WithTimeout(ctx, initializeTimeout)
	capabilities, err := server.initialize(initCtx)
	cancel()
	if err != nil {
		s.removeServer(serverID, server)
		server.forceClose()
		return nil, err
	}

	server.resetIdleTimer()
	return SpawnResult{ServerID: serverID, Capabilities: capabilities}, nil
}

func (s *Service) Send(_ context.Context, raw json.RawMessage) (any, error) {
	var p SendParams
	if err := decodeParams(raw, &p, "lsp.send params must include serverId and message"); err != nil {
		return nil, err
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.sendRaw(p.Message); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Cancel(_ context.Context, raw json.RawMessage) (any, error) {
	var p CancelParams
	if err := decodeParams(raw, &p, "lsp.cancel params must include serverId and requestId"); err != nil {
		return nil, err
	}
	if _, ok := jsonRPCIDKey(p.RequestID); !ok {
		return nil, protocolError("lsp.cancel requestId must be a JSON-RPC id")
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.cancel(p.RequestID); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Shutdown(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ShutdownParams
	if err := decodeParams(raw, &p, "lsp.shutdown params must include serverId"); err != nil {
		return nil, err
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	err = server.Shutdown(ctx)
	s.removeServer(p.ServerID, server)
	if err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) RespondServerRequest(_ context.Context, raw json.RawMessage) (any, error) {
	var p RespondServerRequestParams
	if err := decodeParams(raw, &p, "lsp.respondServerRequest params must include serverId and agentRequestId"); err != nil {
		return nil, err
	}
	if p.AgentRequestID == "" {
		return nil, protocolError("lsp.respondServerRequest agentRequestId is required")
	}
	if len(p.Result) > 0 && len(p.Error) > 0 {
		return nil, protocolError("lsp.respondServerRequest must include result or error, not both")
	}
	if len(p.Result) > 0 && !json.Valid(p.Result) {
		return nil, protocolError("lsp.respondServerRequest result must be valid JSON")
	}
	if len(p.Error) > 0 && !json.Valid(p.Error) {
		return nil, protocolError("lsp.respondServerRequest error must be valid JSON")
	}

	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.respondServerRequest(p); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) nextServerID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextServerSeq++
	return fmt.Sprintf("lsp-%d", s.nextServerSeq)
}

func (s *Service) nextAgentRequestID(serverID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextAgentSeq++
	return fmt.Sprintf("%s-server-request-%d", serverID, s.nextAgentSeq)
}

func (s *Service) storeServer(server *serverProcess) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.servers[server.id] = server
}

func (s *Service) removeServer(id string, expected *serverProcess) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.servers[id] == expected {
		delete(s.servers, id)
	}
}

func (s *Service) lookupServer(id string) (*serverProcess, error) {
	if strings.TrimSpace(id) == "" {
		return nil, protocolError("lsp serverId is required")
	}
	s.mu.Lock()
	server := s.servers[id]
	s.mu.Unlock()
	if server == nil {
		return nil, requestFailed("lsp server not found: %s", id)
	}
	return server, nil
}

func (s *Service) emit(event string, payload any) error {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return nil
	}
	return sink(event, payload)
}

func (s *Service) emitRequired(event string, payload any) error {
	s.mu.Lock()
	sink := s.sink
	s.mu.Unlock()
	if sink == nil {
		return requestFailed("lsp event sink is unavailable")
	}
	return sink(event, payload)
}

func (s *Service) serverRequestCount(serverID string) int {
	s.mu.Lock()
	server := s.servers[serverID]
	s.mu.Unlock()
	if server == nil {
		return 0
	}
	return server.serverRequestCount()
}

func decodeParams(raw json.RawMessage, dst any, message string) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return protocolError(message)
	}
	if err := json.Unmarshal(trimmed, dst); err != nil {
		return protocolError(message)
	}
	return nil
}

func resolveBinaryPath(binaryPath string) (string, error) {
	path := strings.TrimSpace(binaryPath)
	if path == "" || strings.Contains(path, "\x00") {
		return "", protocolError("lsp.spawn binaryPath is required")
	}

	if filepath.IsAbs(path) || strings.ContainsAny(path, `/\`) {
		info, err := os.Stat(path)
		if err != nil {
			return "", requestFailed("lsp.spawn binaryPath is not executable: %s", err)
		}
		if info.IsDir() {
			return "", requestFailed("lsp.spawn binaryPath is a directory: %s", path)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
			return "", requestFailed("lsp.spawn binaryPath is not executable: %s", path)
		}
		return path, nil
	}

	resolved, err := exec.LookPath(path)
	if err != nil {
		return "", requestFailed("lsp.spawn binaryPath is not executable: %s", err)
	}
	return resolved, nil
}
