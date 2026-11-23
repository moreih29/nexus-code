//go:build !windows

package agentrun

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"syscall"
)

func StopDaemon(ctx context.Context, sock string) (bool, error) {
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
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	if !sc.Scan() {
		return false, fmt.Errorf("agent.stopDaemon: no ready frame: %w", scanErr(sc))
	}
	const id = "stop-daemon"
	if _, err := conn.Write([]byte(`{"id":"` + id + `","method":"agent.shutdown"}` + "\n")); err != nil {
		return false, fmt.Errorf("agent.stopDaemon: write: %w", err)
	}
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

func scanErr(sc *bufio.Scanner) error {
	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("EOF")
}
