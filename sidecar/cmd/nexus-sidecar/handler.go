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
	"nexus-code/sidecar/internal/harness"
	"nexus-code/sidecar/internal/wsx"
)

// schema/sidecar-lifecycle.schema.json의 type discriminator 값과 정확히 일치해야 한다.
// TS 측 generated contracts(`packages/shared/src/contracts/generated/sidecar-lifecycle.ts`)와
// 같은 값을 공유하며, drift 검증은 `.github/workflows/contracts-drift.yml`의 Go diff 단계가 담당한다.
const (
	typeSidecarStartCommand = "sidecar/start"
	typeSidecarStartedEvent = "sidecar/started"
	typeSidecarStopCommand  = "sidecar/stop"
	typeSidecarStoppedEvent = "sidecar/stopped"

	closeTimeout = 5 * time.Second
)

var now = time.Now

type LifecycleHandler struct {
	workspaceID string
	bootTime    time.Time
	exit        func(int)

	mu     sync.RWMutex
	server wsx.Server

	harnessObserver *harness.ServerObserver
}

func NewLifecycleHandler(workspaceID string, bootTime time.Time, exit func(int)) *LifecycleHandler {
	return &LifecycleHandler{
		workspaceID:     workspaceID,
		bootTime:        bootTime,
		exit:            exit,
		harnessObserver: harness.NewObserver(contracts.WorkspaceID(workspaceID)),
	}
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
	default:
		fmt.Fprintf(os.Stderr, "WARN: unknown lifecycle message type %q\n", envelope.Type)
		if server := h.getServer(); server != nil {
			_ = server.Close(wsx.StatusInternalError, "unknown message type")
		}
		return errors.New("unknown message type")
	}
}

func (h *LifecycleHandler) OnClose(int, string) {}

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

func (h *LifecycleHandler) getServer() wsx.Server {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.server
}
