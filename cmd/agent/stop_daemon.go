//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentrun"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const stopDaemonTimeout = 3 * time.Second

type stopDaemonParams struct {
	Root string `json:"root"`
}

type stopDaemonResult struct {
	Stopped bool `json:"stopped"`
}

func newStopDaemonHandler(ownRoot string) dispatch.Handler {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		var params stopDaemonParams
		if err := json.Unmarshal(raw, &params); err != nil || params.Root == "" {
			return nil, proto.ProtocolError("agent.stopDaemon: root is required")
		}
		if !filepath.IsAbs(params.Root) {
			return nil, proto.ProtocolError("agent.stopDaemon: root must be absolute")
		}
		if agentrun.WsID(params.Root, proto.ServerVersion) == agentrun.WsID(ownRoot, proto.ServerVersion) {
			return nil, proto.ProtocolError("agent.stopDaemon: root is this daemon's own")
		}
		paths, err := agentrun.For(params.Root, proto.ServerVersion)
		if err != nil {
			return nil, err
		}
		if err := paths.EnsureSocketDir(); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(ctx, stopDaemonTimeout)
		defer cancel()
		stopped, err := agentrun.StopDaemon(ctx, paths.Sock)
		if err != nil {
			return nil, err
		}
		return stopDaemonResult{Stopped: stopped}, nil
	}
}
