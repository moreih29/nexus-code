package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"nexus-code/sidecar/internal/contracts"
	sidecargit "nexus-code/sidecar/internal/git"
	"nexus-code/sidecar/internal/harness"
	"nexus-code/sidecar/internal/lsp"
	"nexus-code/sidecar/internal/search"
	"nexus-code/sidecar/internal/wsx"
)

// schema/sidecar-lifecycle.schema.json의 type discriminator 값과 정확히 일치해야 한다.
// TS 측 generated contracts(`packages/shared/src/contracts/generated/sidecar-lifecycle.ts`)와
// 같은 값을 공유하며, drift 검증은 `.github/workflows/contracts-drift.yml`의 Go diff 단계가 담당한다.
const (
	typeSidecarStartCommand    = "sidecar/start"
	typeSidecarStartedEvent    = "sidecar/started"
	typeSidecarStopCommand     = "sidecar/stop"
	typeSidecarStoppedEvent    = "sidecar/stopped"
	typeLspLifecycleMessage    = "lsp/lifecycle"
	typeLspRelayMessage        = "lsp/relay"
	typeSearchLifecycleMessage = "search/lifecycle"
	typeGitLifecycleMessage    = "git/lifecycle"

	closeTimeout = 5 * time.Second
)

var now = time.Now

type LifecycleHandler struct {
	workspaceID string
	bootTime    time.Time
	exit        func(int)

	mu     sync.RWMutex
	server wsx.Server

	harnessObserver  *harness.ServerObserver
	lspSupervisor    *lsp.Supervisor
	searchSupervisor *search.Supervisor
	gitSupervisor    *sidecargit.Supervisor
}

func NewLifecycleHandler(workspaceID string, bootTime time.Time, exit func(int)) *LifecycleHandler {
	handler := &LifecycleHandler{
		workspaceID:     workspaceID,
		bootTime:        bootTime,
		exit:            exit,
		harnessObserver: harness.NewObserver(contracts.WorkspaceID(workspaceID)),
	}
	handler.lspSupervisor = lsp.NewSupervisor(lsp.SupervisorOptions{
		Emit: handler.send,
	})
	handler.searchSupervisor = search.NewSupervisor(search.SupervisorOptions{
		Emit: handler.send,
	})
	handler.gitSupervisor = sidecargit.NewSupervisor(sidecargit.SupervisorOptions{
		Emit: handler.send,
	})
	return handler
}

func (h *LifecycleHandler) SetServer(server wsx.Server) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.server = server
	h.harnessObserver.SetServer(server)
}

func (h *LifecycleHandler) HarnessObserver() harness.Observer {
	return h.harnessObserver
}

func (h *LifecycleHandler) OnMessage(ctx context.Context, raw []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshal lifecycle envelope: %w", err)
	}

	switch envelope.Type {
	case typeSidecarStartCommand:
		return h.handleStart(ctx, raw)
	case typeSidecarStopCommand:
		return h.handleStop(ctx, raw)
	case typeLspLifecycleMessage:
		return h.handleLspLifecycle(ctx, raw)
	case typeLspRelayMessage:
		return h.handleLspRelay(ctx, raw)
	case typeSearchLifecycleMessage:
		return h.handleSearchLifecycle(ctx, raw)
	case typeGitLifecycleMessage:
		return h.gitSupervisor.HandleLifecycle(ctx, raw, h.workspaceID)
	default:
		fmt.Fprintf(os.Stderr, "WARN: unknown lifecycle message type %q\n", envelope.Type)
		if server := h.getServer(); server != nil {
			_ = server.Close(wsx.StatusInternalError, "unknown message type")
		}
		return errors.New("unknown message type")
	}
}

func (h *LifecycleHandler) OnClose(int, string) {
	_ = h.gitSupervisor.ShutdownAll(context.Background(), nil)
}

func (h *LifecycleHandler) SendStopped(ctx context.Context, exitCode *int) error {
	server := h.getServer()
	if server == nil {
		return nil
	}
	return server.Send(ctx, contracts.SidecarStoppedEvent{
		Type:        typeSidecarStoppedEvent,
		WorkspaceID: contracts.WorkspaceID(h.workspaceID),
		Reason:      contracts.SidecarStoppedReasonRequested,
		StoppedAt:   now().UTC().Format(time.RFC3339Nano),
		ExitCode:    exitCode,
	})
}

func (h *LifecycleHandler) handleStart(ctx context.Context, raw []byte) error {
	var cmd contracts.SidecarStartCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return fmt.Errorf("unmarshal SidecarStartCommand: %w", err)
	}
	if string(cmd.WorkspaceID) != h.workspaceID {
		return fmt.Errorf("workspaceId mismatch: got %q", cmd.WorkspaceID)
	}

	server := h.getServer()
	if server == nil {
		return errors.New("websocket server is not configured")
	}
	return server.Send(ctx, contracts.SidecarStartedEvent{
		Type:        typeSidecarStartedEvent,
		WorkspaceID: cmd.WorkspaceID,
		PID:         os.Getpid(),
		StartedAt:   h.bootTime.UTC().Format(time.RFC3339Nano),
	})
}

func (h *LifecycleHandler) handleStop(ctx context.Context, raw []byte) error {
	var cmd contracts.SidecarStopCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return fmt.Errorf("unmarshal SidecarStopCommand: %w", err)
	}
	if string(cmd.WorkspaceID) != h.workspaceID {
		return fmt.Errorf("workspaceId mismatch: got %q", cmd.WorkspaceID)
	}

	workspaceID := contracts.WorkspaceID(h.workspaceID)
	_ = h.lspSupervisor.ShutdownAll(ctx, &workspaceID, contracts.LspServerStopReasonSidecarStop)
	_ = h.searchSupervisor.ShutdownAll(ctx, &workspaceID)
	_ = h.gitSupervisor.ShutdownAll(ctx, &workspaceID)

	zero := 0
	if err := h.SendStopped(ctx, &zero); err != nil {
		return err
	}
	server := h.getServer()
	if server != nil {
		_ = server.Close(wsx.StatusNormalClosure, "requested")
	}
	h.exit(0)
	return nil
}

func (h *LifecycleHandler) handleLspLifecycle(ctx context.Context, raw []byte) error {
	var envelope struct {
		Action contracts.LspLifecycleAction `json:"action"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshal LSP lifecycle envelope: %w", err)
	}

	switch envelope.Action {
	case contracts.LspLifecycleActionStartServer:
		var cmd contracts.LspStartServerCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal LspStartServerCommand: %w", err)
		}
		return h.lspSupervisor.StartServer(ctx, cmd)
	case contracts.LspLifecycleActionStopServer:
		var cmd contracts.LspStopServerCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal LspStopServerCommand: %w", err)
		}
		return h.lspSupervisor.StopServer(ctx, cmd)
	case contracts.LspLifecycleActionRestartServer:
		var cmd contracts.LspRestartServerCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal LspRestartServerCommand: %w", err)
		}
		return h.lspSupervisor.RestartServer(ctx, cmd)
	case contracts.LspLifecycleActionHealthCheck:
		var cmd contracts.LspHealthCheckCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal LspHealthCheckCommand: %w", err)
		}
		return h.lspSupervisor.HealthCheck(ctx, cmd)
	case contracts.LspLifecycleActionStopAll:
		var cmd contracts.LspStopAllServersCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal LspStopAllServersCommand: %w", err)
		}
		return h.lspSupervisor.StopAll(ctx, cmd)
	default:
		return fmt.Errorf("unknown LSP lifecycle action %q", envelope.Action)
	}
}

func (h *LifecycleHandler) handleLspRelay(ctx context.Context, raw []byte) error {
	var envelope struct {
		Direction contracts.LspRelayDirection `json:"direction"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshal LSP relay envelope: %w", err)
	}
	if envelope.Direction != contracts.LspRelayDirectionClientToServer {
		return fmt.Errorf("unsupported LSP relay direction %q", envelope.Direction)
	}

	var msg contracts.LspClientPayloadMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return fmt.Errorf("unmarshal LspClientPayloadMessage: %w", err)
	}
	return h.lspSupervisor.RelayClientPayload(ctx, msg)
}

func (h *LifecycleHandler) handleSearchLifecycle(ctx context.Context, raw []byte) error {
	var envelope struct {
		Action contracts.SearchLifecycleAction `json:"action"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshal search lifecycle envelope: %w", err)
	}

	switch envelope.Action {
	case contracts.SearchLifecycleActionStart:
		var cmd contracts.SearchStartCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal SearchStartCommand: %w", err)
		}
		if string(cmd.WorkspaceID) != h.workspaceID {
			return fmt.Errorf("workspaceId mismatch: got %q", cmd.WorkspaceID)
		}
		return h.searchSupervisor.Start(ctx, cmd)
	case contracts.SearchLifecycleActionCancel:
		var cmd contracts.SearchCancelCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return fmt.Errorf("unmarshal SearchCancelCommand: %w", err)
		}
		if string(cmd.WorkspaceID) != h.workspaceID {
			return fmt.Errorf("workspaceId mismatch: got %q", cmd.WorkspaceID)
		}
		return h.searchSupervisor.Cancel(ctx, cmd)
	default:
		return fmt.Errorf("unknown search lifecycle action %q", envelope.Action)
	}
}

func (h *LifecycleHandler) send(ctx context.Context, msg any) error {
	server := h.getServer()
	if server == nil {
		return errors.New("websocket server is not configured")
	}
	return server.Send(ctx, msg)
}

func (h *LifecycleHandler) getServer() wsx.Server {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.server
}
