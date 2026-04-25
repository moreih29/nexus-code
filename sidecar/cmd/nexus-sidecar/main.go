package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"nexus-code/sidecar/internal/wsx"
)

const (
	subprotocol = "nexus.sidecar.v1"
	exConfig    = 78
)

func main() {
	bootTime := now()
	token := os.Getenv("NEXUS_SIDECAR_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "FATAL: NEXUS_SIDECAR_TOKEN not set")
		os.Exit(exConfig)
	}

	workspaceID := parseWorkspaceID(os.Args[1:])
	addr, port, err := allocateAddr()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: allocate listen address: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handler := NewLifecycleHandler(workspaceID, bootTime, os.Exit)
	server := wsx.New(addr, token, subprotocol, handler)
	handler.SetServer(server)

	// 신호는 별도 goroutine이 아니라 main goroutine select에서 직접 처리해야
	// readLoop의 defer conn.CloseNow()와의 casClosing race를 줄인다(architect 진단).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigCh)

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(ctx) }()
	if err := waitUntilListening(ctx, addr, serveErr); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: websocket server did not start: %v\n", err)
		os.Exit(1)
	}

	// coder/websocket handles ping/pong frames internally; lifecycle keepalive 정책은 wsx 계층에 둔다.
	fmt.Printf("NEXUS_SIDECAR_READY port=%d pid=%d proto=ws v=1\n", port, os.Getpid())
	fmt.Fprintf(os.Stderr, "nexus-sidecar ready pid=%d workspaceId=%s\n", os.Getpid(), workspaceID)

	select {
	case <-sigCh:
		handleShutdown(server, handler, os.Exit)
	case err := <-serveErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "FATAL: websocket server failed: %v\n", err)
			os.Exit(1)
		}
	}
}

func parseWorkspaceID(args []string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, "--workspace-id=") {
			return strings.TrimPrefix(arg, "--workspace-id=")
		}
	}
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
	}
	return ""
}

func allocateAddr() (string, int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", 0, err
	}
	defer ln.Close()

	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return "", 0, fmt.Errorf("unexpected listener addr %T", ln.Addr())
	}
	return fmt.Sprintf("127.0.0.1:%d", tcpAddr.Port), tcpAddr.Port, nil
}

func waitUntilListening(ctx context.Context, addr string, serveErr <-chan error) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	for {
		select {
		case err := <-serveErr:
			if err == nil {
				return errors.New("server exited before readiness")
			}
			return err
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		conn, err := net.DialTimeout("tcp", addr, 20*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// handleShutdown은 main goroutine의 signal select에서 호출된다.
// coder/websocket Close는 5s 동안 peer의 echo close frame을 동기 대기하므로
// 별도 sleep 없이도 close handshake가 wire에 도달함을 보장한다(architect 진단).
func handleShutdown(server wsx.Server, handler *LifecycleHandler, exit func(int)) {
	ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
	defer cancel()
	_ = handler.SendStopped(ctx, nil)
	_ = server.Close(wsx.StatusGoingAway, "going away")
	exit(0)
}
