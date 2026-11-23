//go:build !windows

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

const ExitCodeDaemonClosed = 5

func runDialer(sockPath string) {
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		os.Exit(ExitCodeDialFailed)
	}

	_ = agentrun.SetConnectionAuthSock(agentrun.AuthSockFor(sockPath), os.Getenv("SSH_AUTH_SOCK"))

	signal.Ignore(syscall.SIGPIPE)

	daemonDone := make(chan struct{})
	go func() {
		defer close(daemonDone)
		if !relay(os.Stdout, conn) {
			_, _ = io.Copy(io.Discard, conn)
		}
	}()
	appDone := make(chan struct{})
	go func() {
		if relay(conn, os.Stdin) {
			close(appDone)
			if unixConn, ok := conn.(*net.UnixConn); ok {
				_ = unixConn.CloseWrite()
			}
		}
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
	<-daemonDone
	os.Exit(0)
}

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
