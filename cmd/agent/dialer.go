// dialer.go implements the `agent --dial <socketPath>` execution path.
//
// The dialer is a thin bidirectional relay: it connects to the daemon's Unix
// socket and copies bytes between that socket and its own stdin/stdout. It has
// no state of its own and introduces no buffering beyond what the OS provides.
//
// ssh exec runs `agent --dial <sock>` as the session command. From the Electron
// main's perspective this dialer is indistinguishable from a direct agent — it
// reads from stdin and writes to stdout using the same NDJSON protocol. The
// daemon's Ready frame travels through the dialer unchanged as the first line
// on stdout.
//
// Exit codes:
//   - 0: socket was closed cleanly (dialer EOF or daemon closed connection).
//   - ExitCodeDialFailed (4): connect failed — no daemon listening at sockPath.
package main

import (
	"io"
	"net"
	"os"
	"time"
)

// runDialer is the `agent --dial <sockPath>` entry point.
//
// It connects to sockPath, then bidirectionally copies:
//   - stdin → socket (client requests to daemon)
//   - socket → stdout (daemon responses / events to client)
//
// No self-buffering: io.Copy uses the OS pipe buffer. The dialer's job is
// purely transport relay — protocol framing is the daemon's responsibility.
func runDialer(sockPath string) {
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		// ECONNREFUSED or any connect failure: daemon is not present.
		// Exit with the well-known code so the launcher can start a new daemon.
		os.Exit(ExitCodeDialFailed)
	}
	defer conn.Close()

	// Copy socket → stdout in a goroutine; copy stdin → socket in the foreground.
	// Both directions run concurrently; the first to finish (EOF or error) causes
	// the other to be interrupted via conn.Close().
	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(os.Stdout, conn)
		done <- struct{}{}
	}()

	_, _ = io.Copy(conn, os.Stdin)
	// Stdin closed: half-close the socket write side to signal EOF to the daemon.
	if tc, ok := conn.(*net.UnixConn); ok {
		_ = tc.CloseWrite()
	}

	// Wait for the socket→stdout copy to finish so we don't exit before the
	// daemon's final frames (e.g. a shutdown event) reach the client.
	<-done
}
