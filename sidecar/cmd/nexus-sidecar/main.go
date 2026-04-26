package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"nexus-code/sidecar/internal/contracts"
	"nexus-code/sidecar/internal/harness"
	"nexus-code/sidecar/internal/wsx"
)

const (
	subprotocol = "nexus.sidecar.v1"
	exConfig    = 78
	exUsage     = 64
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook" {
		os.Exit(runHookCommand(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}

	bootTime := now()
	token := os.Getenv("NEXUS_SIDECAR_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "FATAL: NEXUS_SIDECAR_TOKEN not set")
		os.Exit(exConfig)
	}

	options := parseServerOptions(os.Args[1:])
	workspaceID := options.workspaceID
	addr, port, err := allocateAddr()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: allocate listen address: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var hookListener *harness.HookListener
	exit := func(code int) {
		if hookListener != nil {
			_ = hookListener.Close()
		}
		os.Exit(code)
	}

	handler := NewLifecycleHandler(workspaceID, bootTime, exit)
	server := wsx.New(addr, token, subprotocol, handler)
	handler.SetServer(server)

	var hookErr <-chan error
	if options.dataDir != "" {
		if workspaceID == "" {
			fmt.Fprintln(os.Stderr, "FATAL: --workspace-id is required when --data-dir is set")
			os.Exit(exConfig)
		}
		observer := harness.NewObserver(
			contracts.WorkspaceID(workspaceID),
			harness.WithDefaultAdapterName("claude-code"),
			harness.WithServer(server),
		)
		listener, err := harness.NewHookListener(harness.HookListenerConfig{
			DataDir:     options.dataDir,
			WorkspaceID: contracts.WorkspaceID(workspaceID),
			Sink:        observer,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: configure hook listener: %v\n", err)
			os.Exit(exConfig)
		}
		hookListener = listener
		errCh := make(chan error, 1)
		hookErr = errCh
		go func() { errCh <- listener.Serve(ctx) }()
		if err := listener.WaitReady(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: hook listener did not start: %v\n", err)
			os.Exit(1)
		}
	}

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
		cancel()
		if hookListener != nil {
			_ = hookListener.Close()
		}
		handleShutdown(server, handler, exit)
	case err := <-hookErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "FATAL: hook listener failed: %v\n", err)
			os.Exit(1)
		}
	case err := <-serveErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "FATAL: websocket server failed: %v\n", err)
			os.Exit(1)
		}
	}
}

type serverOptions struct {
	workspaceID string
	dataDir     string
}

func parseServerOptions(args []string) serverOptions {
	var options serverOptions
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--workspace-id" && i+1 < len(args):
			i++
			options.workspaceID = args[i]
		case strings.HasPrefix(arg, "--workspace-id="):
			options.workspaceID = strings.TrimPrefix(arg, "--workspace-id=")
		case arg == "--data-dir" && i+1 < len(args):
			i++
			options.dataDir = args[i]
		case strings.HasPrefix(arg, "--data-dir="):
			options.dataDir = strings.TrimPrefix(arg, "--data-dir=")
		case options.workspaceID == "" && !strings.HasPrefix(arg, "-"):
			options.workspaceID = arg
		}
	}
	return options
}

func parseWorkspaceID(args []string) string {
	return parseServerOptions(args).workspaceID
}

func runHookCommand(args []string, stdin io.Reader, _ io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("hook", flag.ContinueOnError)
	flags.SetOutput(stderr)
	socketPath := flags.String("socket", "", "Unix socket path")
	workspaceID := flags.String("workspace-id", "", "workspace id")
	eventName := flags.String("event", "", "hook event type")
	tokenPath := flags.String("token-file", "", "token file path (defaults to sibling .token)")
	if err := flags.Parse(args); err != nil {
		return exUsage
	}

	payload, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "hook: read stdin: %v\n", err)
		return 1
	}
	if err := harness.SendHookEvent(context.Background(), harness.HookClientConfig{
		SocketPath:  *socketPath,
		TokenPath:   *tokenPath,
		WorkspaceID: contracts.WorkspaceID(*workspaceID),
		Event:       *eventName,
		Payload:     payload,
	}); err != nil {
		fmt.Fprintf(stderr, "hook: %v\n", err)
		return 1
	}
	return 0
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
