package lsp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"github.com/nexus-code/nexus-code/internal/proto"
)

type Service struct {
	mu      sync.Mutex
	sink    EventSink
	servers map[string]*serverProcess
	closed  bool

	serverIDPrefix string
	nextServerSeq  uint64
	nextAgentSeq   uint64
}

func New() *Service {
	return &Service{servers: make(map[string]*serverProcess), serverIDPrefix: newServerIDPrefix()}
}

func newServerIDPrefix() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("lsp.spawn", service.Spawn)
	d.RegisterOrderedBy("lsp.send", service.Send, serverQueueKey)
	d.RegisterOrderedBy("lsp.notify", service.Notify, serverQueueKey)
	d.RegisterOrderedBy("lsp.cancel", service.Cancel, serverQueueKey)
	d.Register("lsp.shutdown", service.Shutdown)
	d.RegisterOrderedBy("lsp.respondServerRequest", service.RespondServerRequest, serverQueueKey)
	d.Register("lsp.stats", service.Stats)
	d.Register("lsp.findBinary", service.FindBinary)
}

func serverQueueKey(raw json.RawMessage) string {
	var params struct {
		ServerID string `json:"serverId"`
	}
	_ = json.Unmarshal(raw, &params)
	return "lsp:" + params.ServerID
}

func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	servers := make([]*serverProcess, 0, len(s.servers))
	for id, server := range s.servers {
		servers = append(servers, server)
		delete(s.servers, id)
	}
	s.mu.Unlock()

	var cleanup sync.WaitGroup
	for _, server := range servers {
		cleanup.Add(1)
		go func() {
			defer cleanup.Done()
			server.forceClose()
		}()
	}
	cleanup.Wait()
}

func (s *Service) Spawn(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SpawnParams
	if err := proto.DecodeParams(raw, &p, "lsp.spawn params must include workspaceId, languageId, binaryPath, args, and workspaceRoot"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.WorkspaceID) == "" {
		return nil, proto.ProtocolError("lsp.spawn workspaceId is required")
	}
	if strings.TrimSpace(p.LanguageID) == "" {
		return nil, proto.ProtocolError("lsp.spawn languageId is required")
	}
	if strings.TrimSpace(p.WorkspaceRoot) == "" {
		return nil, proto.ProtocolError("lsp.spawn workspaceRoot is required")
	}

	binaryPath, err := resolveBinaryPath(p.BinaryPath)
	if err != nil {
		return nil, err
	}
	workspaceRoot, err := filepath.Abs(p.WorkspaceRoot)
	if err != nil {
		return nil, proto.RequestFailed("invalid workspaceRoot: %s", proto.Reason(err))
	}
	workspaceRoot = filepath.Clean(workspaceRoot)

	idleTimeout := defaultIdleTimeout
	if p.IdleTimeoutMs != nil {
		if *p.IdleTimeoutMs < 0 {
			return nil, proto.ProtocolError("lsp.spawn idleTimeoutMs must be non-negative")
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
		Env:           p.Env,

		InitializationOptions: p.InitializationOptions,
	}, idleTimeout)
	if err := s.startServer(ctx, server); err != nil {
		return nil, err
	}

	_ = s.emit(EventServerAssigned, ServerAssignedPayload{
		ServerID:      serverID,
		CorrelationID: p.CorrelationID,
	})

	initCtx, cancel := context.WithTimeout(ctx, initializeTimeout)
	capabilities, serverInfo, err := server.initialize(initCtx)
	cancel()
	if err != nil {
		s.removeServer(serverID, server)
		server.forceClose()
		return nil, err
	}

	server.resetIdleTimer()
	return SpawnResult{ServerID: serverID, Capabilities: capabilities, ServerInfo: serverInfo}, nil
}

func (s *Service) startServer(ctx context.Context, server *serverProcess) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return proto.RequestFailed("lsp service closed")
	}
	if err := server.start(ctx); err != nil {
		return err
	}
	s.servers[server.id] = server
	return nil
}

func (s *Service) Stats(_ context.Context, _ json.RawMessage) (any, error) {
	s.mu.Lock()
	servers := make([]*serverProcess, 0, len(s.servers))
	for _, server := range s.servers {
		servers = append(servers, server)
	}
	s.mu.Unlock()

	table, err := processTable()
	if err != nil {
		return nil, proto.RequestFailed("lsp.stats failed: %s", proto.Reason(err))
	}
	pids := make([]int, 0, len(servers))
	for _, server := range servers {
		pids = append(pids, server.processID())
	}
	totals := treeRSS(table, pids)
	result := StatsResult{Servers: make([]ServerStats, 0, len(servers))}
	for _, server := range servers {
		pid := server.processID()
		if pid == 0 {
			continue
		}
		result.Servers = append(result.Servers, ServerStats{ServerID: server.id, RSSBytes: totals[pid]})
	}
	return result, nil
}

func (s *Service) Send(ctx context.Context, raw json.RawMessage) (any, error) {
	var p SendParams
	if err := proto.DecodeParams(raw, &p, "lsp.send params must include serverId and message"); err != nil {
		return nil, err
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.sendRaw(ctx, p.Message); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Notify(ctx context.Context, raw json.RawMessage) (any, error) {
	var p NotifyParams
	if err := proto.DecodeParams(raw, &p, "lsp.notify params must include serverId and message"); err != nil {
		return nil, err
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.sendRaw(ctx, p.Message); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Cancel(ctx context.Context, raw json.RawMessage) (any, error) {
	var p CancelParams
	if err := proto.DecodeParams(raw, &p, "lsp.cancel params must include serverId and requestId"); err != nil {
		return nil, err
	}
	if _, ok := jsonRPCIDKey(p.RequestID); !ok {
		return nil, proto.ProtocolError("lsp.cancel requestId must be a JSON-RPC id")
	}
	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.cancel(ctx, p.RequestID); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) Shutdown(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ShutdownParams
	if err := proto.DecodeParams(raw, &p, "lsp.shutdown params must include serverId"); err != nil {
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

func (s *Service) RespondServerRequest(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RespondServerRequestParams
	if err := proto.DecodeParams(raw, &p, "lsp.respondServerRequest params must include serverId and agentRequestId"); err != nil {
		return nil, err
	}
	if p.AgentRequestID == "" {
		return nil, proto.ProtocolError("lsp.respondServerRequest agentRequestId is required")
	}
	if len(p.Result) > 0 && len(p.Error) > 0 {
		return nil, proto.ProtocolError("lsp.respondServerRequest must include result or error, not both")
	}
	if len(p.Result) > 0 && !json.Valid(p.Result) {
		return nil, proto.ProtocolError("lsp.respondServerRequest result must be valid JSON")
	}
	if len(p.Error) > 0 && !json.Valid(p.Error) {
		return nil, proto.ProtocolError("lsp.respondServerRequest error must be valid JSON")
	}

	server, err := s.lookupServer(p.ServerID)
	if err != nil {
		return nil, err
	}
	server.resetIdleTimer()
	if err := server.respondServerRequest(ctx, p); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) nextServerID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextServerSeq++
	return fmt.Sprintf("lsp-%s-%d", s.serverIDPrefix, s.nextServerSeq)
}

func (s *Service) nextAgentRequestID(serverID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextAgentSeq++
	return fmt.Sprintf("%s-server-request-%d", serverID, s.nextAgentSeq)
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
		return nil, proto.ProtocolError("lsp serverId is required")
	}
	s.mu.Lock()
	server := s.servers[id]
	s.mu.Unlock()
	if server == nil {
		return nil, proto.RequestFailed("lsp server not found: %s", id)
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
		return proto.RequestFailed("lsp event sink is unavailable")
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

func resolveBinaryPath(binaryPath string) (string, error) {
	path := strings.TrimSpace(binaryPath)
	if path == "" || strings.Contains(path, "\x00") {
		return "", proto.ProtocolError("lsp.spawn binaryPath is required")
	}

	if filepath.IsAbs(path) || strings.ContainsAny(path, `/\`) {
		info, err := os.Stat(path)
		if err != nil {
			return "", proto.RequestFailed("lsp.spawn binaryPath is not executable: %s", err)
		}
		if info.IsDir() {
			return "", proto.RequestFailed("lsp.spawn binaryPath is a directory: %s", path)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
			return "", proto.RequestFailed("lsp.spawn binaryPath is not executable: %s", path)
		}
		return path, nil
	}

	resolved, err := exec.LookPath(path)
	if err != nil {
		return "", proto.RequestFailed("lsp.spawn binaryPath is not executable: %s", err)
	}
	return resolved, nil
}
