//go:build !windows

// dialer.go implements the `agent --dial <socketPath>` execution path.
//
// The dialer is a thin bidirectional relay: it connects to the daemon's Unix
// socket and copies bytes between that socket and its own stdin/stdout. It has
// no state of its own and holds no more than one read's worth of bytes.
//
// ssh exec runs `agent --dial <sock>` as the session command. From the Electron
// main's perspective this dialer is indistinguishable from a direct agent — it
// reads from stdin and writes to stdout using the same NDJSON protocol. The
// daemon's Ready frame travels through the dialer unchanged as the first line
// on stdout.
//
// Exit codes:
//   - 0: the app closed its side (stdin ended), and the daemon then closed
//     the connection.
//   - ExitCodeDialFailed (4): connect failed — no daemon listening at sockPath.
//   - ExitCodeDaemonClosed (5): the daemon closed the connection first.
package main

import (
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentrun"
)

// ExitCodeDaemonClosed is returned when the daemon's side of the connection
// ends while the app's is still open: the daemon exited or was killed, or
// another dialer took it over. The app reconnects on it — starting a daemon
// if there is none — except after the daemon's preemptedEvent, which tells
// it another connection has the daemon now. Before this the dialer waited for
// the app's next write and then exited 0, which the app took for a clean
// close and never reconnected.
const ExitCodeDaemonClosed = 5

// runDialer is the `agent --dial <sockPath>` entry point.
//
// It connects to sockPath, then bidirectionally copies:
//   - stdin → socket (client requests to daemon)
//   - socket → stdout (daemon responses / events to client)
//
// and exits as soon as the daemon closes the connection, or once the app has
// closed its side and the daemon then closes the connection too.
func runDialer(sockPath string) {
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		// ECONNREFUSED or any connect failure: daemon is not present.
		// Exit with the well-known code so the launcher can start a new daemon.
		os.Exit(ExitCodeDialFailed)
	}

	// Hand this connection's forwarded SSH agent to the daemon's children,
	// which reach it through the link the daemon exported (runDaemon).
	_ = agentrun.PointAuthSock(agentrun.AuthSockFor(sockPath), os.Getenv("SSH_AUTH_SOCK"))

	// A write to an output no one reads any more fails rather than killing
	// the dialer: it still has to read what the daemon sends (below).
	signal.Ignore(syscall.SIGPIPE)

	daemonDone := make(chan struct{})
	go func() {
		defer close(daemonDone)
		if !relay(os.Stdout, conn) {
			// The app is gone: the SSH session ended under the dialer. Read on
			// until the daemon closes the connection. A socket closed with data
			// unread reaches the daemon as a reset, not as the end of the
			// connection.
			_, _ = io.Copy(io.Discard, conn)
		}
	}()
	appDone := make(chan struct{})
	go func() {
		if relay(conn, os.Stdin) {
			// Stdin ended: tell the daemon this dialer is done, and let it
			// close the connection. Marked done first: the daemon's close
			// that answers the half-close must find the app gone, not be
			// taken for the daemon going (ExitCodeDaemonClosed).
			close(appDone)
			if unixConn, ok := conn.(*net.UnixConn); ok {
				_ = unixConn.CloseWrite()
			}
		}
		// Otherwise the daemon's side failed, which daemonDone tells.
	}()

	select {
	case <-appDone:
	case <-daemonDone:
		select {
		case <-appDone:
		default:
			os.Exit(ExitCodeDaemonClosed)
		}
	}
	// Wait for the daemon to close, so its final frames reach the app and it
	// sees this dialer leave cleanly.
	<-daemonDone
	os.Exit(0)
}

// relay copies src to dst until src ends, reporting false when a write to
// dst failed first.
func relay(dst io.Writer, src io.Reader) bool {
	buf := make([]byte, 32*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			if _, err := dst.Write(buf[:n]); err != nil {
				return false
			}
		}
		if readErr != nil {
			return true
		}
	}
}
