//go:build !windows

// stop_daemon.go implements agent.stopDaemon: one daemon asking another on
// the same host to exit.
//
// The app asks a removed workspace's daemon to exit with agent.shutdown over
// that workspace's own connection. A workspace removed while not connected
// has none, and its daemon would hold its terminals, Claude tabs and language
// servers until the reattach grace ends. The app asks a connected daemon on
// the same host instead, which reaches the other one through its socket the
// way a dialer does.

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

// stopDaemonTimeout bounds one agent.stopDaemon: the dial, the other
// daemon's Ready frame and its reply to agent.shutdown.
const stopDaemonTimeout = 3 * time.Second

type stopDaemonParams struct {
	// Root is the workspace root the other daemon serves.
	Root string `json:"root"`
}

type stopDaemonResult struct {
	// Stopped is false when no daemon serves Root at this agent's version.
	Stopped bool `json:"stopped"`
}

// newStopDaemonHandler serves agent.stopDaemon for the daemon of ownRoot,
// which it never stops: dialing its own socket would take its connection
// away from the app.
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
