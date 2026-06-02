// Binary agent is the workspace-bound Go process that the
// Electron main reaches over a per-workspace NDJSON channel
// (stdin/stdout in production; SSH-tunneled stdio for remote workspaces).
//
// This entry file is intentionally thin: it parses the workspace root
// from argv, builds the fs registry, hands off to stdioserver, and
// emits the boot Ready frame. Everything past that — request scanning,
// goroutine dispatch, response serialization, signal handling — lives
// in internal/stdioserver so this file stays at a glance-readable size.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentgit "github.com/nexus-code/nexus-code/internal/git"
	"github.com/nexus-code/nexus-code/internal/hookclient"
	"github.com/nexus-code/nexus-code/internal/hookserver"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
	agentpty "github.com/nexus-code/nexus-code/internal/pty"
	agentsearch "github.com/nexus-code/nexus-code/internal/search"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

func main() {
	// hook 서브커맨드 분기 — PTY/FS/Git/LSP 서비스 init 전에 처리해 빠른 시작을 보장한다.
	// Claude Code는 hook 이벤트 발생 시 `agent hook <subcommand>` 형태로 호출한다.
	if len(os.Args) >= 2 && os.Args[1] == "hook" {
		os.Exit(hookclient.Run(os.Args[2:]))
	}

	if code, ok := askpassExitFromArgv(os.Args); ok {
		os.Exit(code)
	}

	// agentLogger writes structured JSON to stderr. Every record carries the
	// fixed marker attribute "src":"agent-log" so that the parent process
	// (pipe.ts) can distinguish these structured lines from panic output and
	// classifier text that also arrive on the same stderr stream.
	agentLogger := slog.New(slog.NewJSONHandler(os.Stderr, nil)).With("src", "agent-log")

	root := rootPathFromArgv(os.Args)
	if root == "" {
		agentLogger.Error("Usage: agent <rootPath>")
		os.Exit(2)
	}

	fsys, err := agentfs.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize fs", "err", err)
		os.Exit(2)
	}
	git := agentgit.New(root)
	lsp := agentlsp.New()
	pty := agentpty.New()
	search, err := agentsearch.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize search", "err", err)
		os.Exit(2)
	}

	// hookserver를 시작한다. 실패(소켓 경로 초과 등)하면 경고만 로그하고
	// hook 비활성화 모드로 계속 운영한다 — agent 기본 기능은 영향 없음.
	var hooksrv *hookserver.Server
	if hs, err := hookserver.New(hookserver.AgentKey(root), nil); err != nil {
		agentLogger.Warn("hookserver unavailable", "err", err)
	} else {
		hooksrv = hs
	}

	d := dispatch.New()
	agentfs.Register(d, fsys)
	agentgit.Register(d, git)
	agentlsp.Register(d, lsp)
	agentpty.Register(d, pty)
	agentsearch.Register(d, search)
	if hooksrv != nil {
		hookserver.Register(d, hooksrv)
	}

	// hook.getInfo — pull 기반 RPC. TS 클라이언트가 ready 이후 언제든 호출해
	// hookserver의 소켓 경로와 토큰을 얻는다. push 이벤트 방식 대신 이 pull
	// 방식을 사용하면 listener 등록 시점 race가 발생하지 않는다.
	// hooksrv가 nil이면 newHookGetInfoHandler(nil)로 전달해야 인터페이스 nil
	// 비교가 올바르게 동작한다(*T → interface 변환 시 nil 포인터는 non-nil 인터페이스).
	var hookProvider hookInfoProvider
	if hooksrv != nil {
		hookProvider = hooksrv
	}
	d.Register("hook.getInfo", newHookGetInfoHandler(hookProvider))

	// ping — client keepalive. The TS client calls this periodically so the
	// idle watchdog (StartIdleWatchdog below) can tell a live-but-idle session
	// from a vanished client. The handler is a no-op; merely receiving the line
	// resets the agent's lastInbound timestamp.
	d.Register("ping", func(_ context.Context, _ json.RawMessage) (any, error) {
		return struct{}{}, nil
	})

	host := stdioserver.New(d, os.Stdin, os.Stdout, agentLogger)
	fsys.SetEventSink(func(event string, payload any) error {
		err := host.EmitEvent(event, payload)
		if event == "fs.changed" {
			if changed, ok := payload.(agentfs.FsChangedPayload); ok {
				if routeErr := lsp.HandleFSChanged(changed); err == nil {
					err = routeErr
				}
			}
		}
		return err
	})
	git.SetEventSink(host.EmitEvent)
	lsp.SetEventSink(host.EmitEvent)
	pty.SetEventSink(host.EmitEvent)
	search.SetEventSink(host.EmitEvent)
	if hooksrv != nil {
		// hookserver의 EventSink를 host가 생성된 뒤 연결한다.
		// 다른 서비스(fs/git/pty)의 SetEventSink와 같은 패턴.
		hooksrv.SetEventSink(host.EmitEvent)
	}
	defer fsys.Close()
	defer git.Close()
	defer lsp.Close()
	defer pty.Close()
	if hooksrv != nil {
		// SIGTERM 경로는 os.Exit가 defer를 우회하므로 shutdown hook으로 등록한다.
		// hookserver는 /tmp/nexus-h-*.sock 파일을 생성하므로 정리하지 않으면
		// 재부팅 시 다른 pid → 다른 경로가 되어 orphan 소켓이 누적된다.
		// 정상 EOF 종료에서도 동일 경로로 실행되므로 defer는 제거하고 hook 일원화한다.
		host.RegisterShutdownHook(func() { _ = hooksrv.Close() })
	}
	host.InstallSigtermHandler()

	// Ready frame must reach the client before any other output so the
	// channel handshake on the TS side can settle. A write failure here
	// is unrecoverable — without a Ready, the client will time out.
	// methods 목록과 heartbeat 간격(10s)을 함께 전달해 클라이언트가 pull 기반으로
	// hook.getInfo를 호출할 수 있음을 알린다.
	if err := host.WriteFrame(proto.Ready(d.Methods(), 10_000)); err != nil {
		agentLogger.Error("failed to write ready frame", "err", err)
		os.Exit(1)
	}

	// 10초 간격 heartbeat를 시작한다. Ready frame에 광고한 heartbeatIntervalMs와
	// 일치해야 한다. ctx 취소(드레인) 시 자동 정지한다.
	host.StartHeartbeat(10 * time.Second)

	// Idle watchdog: self-terminate if the client sends nothing for 60s. The
	// client pings every ~20s (KEEPALIVE_PING_INTERVAL_MS in pipe.ts), so a
	// healthy idle session resets the timer ~3× per window; only a vanished
	// client (half-open TCP, hung process, sleep) with no stdin EOF trips it,
	// preventing an orphaned remote agent from holding its binary.
	host.StartIdleWatchdog(60 * time.Second)

	host.Run()
}

// hookInfoProvider 는 hook.getInfo handler가 hookserver에서 필요한 메서드만
// 추상화한 인터페이스다. *hookserver.Server가 이를 구현하며, 테스트에서는
// 독립적인 fake 구현으로 대체할 수 있다.
type hookInfoProvider interface {
	WaitReady(ctx context.Context) error
	SocketPath() string
	Token() string
}

// newHookGetInfoHandler 는 hook.getInfo dispatch handler를 반환한다.
// hs가 nil이면 즉시 CodeUnavailable 에러를 반환하는 핸들러를 반환한다.
// 정상 시 5초 timeout으로 WaitReady를 기다린 후 socketPath + token을 반환한다.
func newHookGetInfoHandler(hs hookInfoProvider) dispatch.Handler {
	return func(ctx context.Context, _ json.RawMessage) (any, error) {
		if hs == nil {
			return nil, proto.NewError(proto.CodeUnavailable, "hookserver not started")
		}
		waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := hs.WaitReady(waitCtx); err != nil {
			return nil, proto.NewError(proto.CodeUnavailable, "hookserver not ready: "+err.Error())
		}
		return map[string]any{
			"socketPath": hs.SocketPath(),
			"token":      hs.Token(),
		}, nil
	}
}

// rootPathFromArgv extracts the workspace root from argv. We accept
// exactly one positional argument and return "" when it is missing so
// the caller can print usage and exit non-zero.
func rootPathFromArgv(argv []string) string {
	if len(argv) > 1 {
		return argv[1]
	}
	return ""
}

// askpassExitFromArgv detects both the explicit `agent --askpass <socket>`
// helper mode and the Git-compatible env mode used when GIT_ASKPASS can only
// name an executable path.
func askpassExitFromArgv(argv []string) (int, bool) {
	if len(argv) >= 3 && argv[1] == "--askpass" {
		return agentgit.RunAskpassHelper(argv[2], argv[3:], os.Stdout, os.Stderr), true
	}
	if socketPath, ok := agentgit.AskpassSocketFromEnv(); ok {
		return agentgit.RunAskpassHelper(socketPath, argv[1:], os.Stdout, os.Stderr), true
	}
	return 0, false
}
