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
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"syscall"
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
		ctx, cancel := context.WithTimeout(ctx, stopDaemonTimeout)
		defer cancel()
		stopped, err := stopDaemonAt(ctx, paths.Sock)
		if err != nil {
			return nil, err
		}
		return stopDaemonResult{Stopped: stopped}, nil
	}
}

// stopDaemonAt asks the daemon listening on sock to exit and waits for its
// reply. It returns false, without error, when nothing listens there: no
// socket, or one left by a daemon that is gone.
func stopDaemonAt(ctx context.Context, sock string) (bool, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", sock)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
			return false, nil
		}
		return false, fmt.Errorf("agent.stopDaemon: dial: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	// Close the connection when ctx is canceled, so a blocked read returns.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	// The daemon greets every dialer with its Ready frame first.
	if !sc.Scan() {
		return false, fmt.Errorf("agent.stopDaemon: no ready frame: %w", scanErr(sc))
	}
	const id = "stop-daemon"
	if _, err := conn.Write([]byte(`{"id":"` + id + `","method":"agent.shutdown"}` + "\n")); err != nil {
		return false, fmt.Errorf("agent.stopDaemon: write: %w", err)
	}
	// Events and heartbeats may come before the reply.
	for sc.Scan() {
		var frame struct {
			ID    string          `json:"id"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &frame) != nil || frame.ID != id {
			continue
		}
		if len(frame.Error) > 0 && string(frame.Error) != "null" {
			return false, fmt.Errorf("agent.stopDaemon: agent.shutdown failed: %s", frame.Error)
		}
		return true, nil
	}
	return false, fmt.Errorf("agent.stopDaemon: no reply: %w", scanErr(sc))
}

// scanErr is why a scan ended: its error, or EOF when it has none.
func scanErr(sc *bufio.Scanner) error {
	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("EOF")
}
