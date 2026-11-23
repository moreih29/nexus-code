package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/agentrun"
	agentchat "github.com/nexus-code/nexus-code/internal/chat"
	"github.com/nexus-code/nexus-code/internal/cliclient"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentgit "github.com/nexus-code/nexus-code/internal/git"
	"github.com/nexus-code/nexus-code/internal/hookclient"
	"github.com/nexus-code/nexus-code/internal/hookserver"
	"github.com/nexus-code/nexus-code/internal/inheritfd"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
	agentpty "github.com/nexus-code/nexus-code/internal/pty"
	agentsearch "github.com/nexus-code/nexus-code/internal/search"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
	"github.com/nexus-code/nexus-code/internal/sysstat"
)

func main() {
	inheritfd.CloseOnExec()
	if code, handled := hookclient.PrintChildHelper(os.Args[1:]); handled {
		os.Exit(code)
	}

	if len(os.Args) >= 2 && os.Args[1] == "hook" {
		os.Exit(hookclient.Run(os.Args[2:]))
	}

	if len(os.Args) >= 2 && os.Args[1] == "print-run" {
		os.Exit(hookclient.RunPrint(os.Args[2:]))
	}

	if len(os.Args) >= 2 && os.Args[1] == "exec-run" {
		os.Exit(hookclient.RunCodexExec(os.Args[2:]))
	}

	if len(os.Args) >= 2 && os.Args[1] == "cli" {
		os.Exit(cliclient.Run(os.Args[2:]))
	}

	if len(os.Args) >= 2 && os.Args[1] == "package-run" {
		os.Exit(runPackageProgram(os.Args[2:]))
	}

	if code, ok := askpassExitFromArgv(os.Args); ok {
		os.Exit(code)
	}

	agentLogger := slog.New(slog.NewJSONHandler(os.Stderr, nil)).With("src", "agent-log")

	args := parseRunArgs(os.Args)

	if args.daemonRoot != "" {
		runDaemon(args.daemonRoot)
		return
	}

	if args.dialRoot != "" {
		paths, err := agentrun.For(args.dialRoot, proto.ServerVersion)
		if err == nil {
			err = paths.EnsureSocketDir()
		}
		if err != nil {
			agentLogger.Error("daemon socket directory unavailable", "err", err)
			os.Exit(1)
		}
		runDialer(paths.Sock)
		return
	}

	if args.dialSock != "" {
		runDialer(args.dialSock)
		return
	}

	if args.root == "" {
		agentLogger.Error("Usage: agent [--idle-watchdog] <rootPath>")
		os.Exit(2)
	}
	root := args.root
	idleWatchdog := args.idleWatchdog
	endOrphanedPrograms(root, agentLogger)

	fsys, err := agentfs.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize fs", "err", err)
		os.Exit(2)
	}
	git := agentgit.New(root)
	lsp := agentlsp.New()
	pty := agentpty.New()
	chat := agentchat.New()
	search, err := agentsearch.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize search", "err", err)
		os.Exit(2)
	}

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
	agentchat.Register(d, chat)
	agentsearch.Register(d, search)
	sysstat.Register(d, sysstat.New())
	if hooksrv != nil {
		hookserver.Register(d, hooksrv)
	}

	var hookProvider hookInfoProvider
	if hooksrv != nil {
		hookProvider = hooksrv
	}
	d.Register("hook.getInfo", newHookGetInfoHandler(hookProvider))

	d.Register("ping", func(_ context.Context, _ json.RawMessage) (any, error) {
		return struct{}{}, nil
	})

	host := stdioserver.New(d, os.Stdin, os.Stdout, agentLogger)
	fsys.SetEventSink(fsEventSink(host, lsp))
	git.SetEventSink(host.EmitEvent)
	lsp.SetEventSink(host.EmitEvent)
	pty.SetEventSink(host.Context(), host.EmitEvent)
	chat.SetConnectionSink(host.Context(), host.EmitEvent)
	search.SetEventSink(host.EmitEvent)
	if hooksrv != nil {
		hooksrv.SetEventSink(host.EmitEvent)
	}
	host.RegisterShutdownHook(func() {
		var cleanup sync.WaitGroup
		for _, closeService := range []func(){pty.Close, chat.Close, lsp.Close, fsys.Close, git.Close} {
			cleanup.Add(1)
			go func() {
				defer cleanup.Done()
				closeService()
			}()
		}
		cleanup.Wait()
	})
	if hooksrv != nil {
		host.RegisterShutdownHook(func() { _ = hooksrv.Close() })
	}
	host.InstallSigtermHandler()

	idleWatchdogMs := 0
	if idleWatchdog {
		idleWatchdogMs = int((300 * time.Second) / time.Millisecond)
	}

	if err := host.WriteFrame(
		proto.Ready(d.Methods(), proto.HeartbeatAdvertiseMs, idleWatchdogMs, 0, []string{agentchat.RunCapability}),
	); err != nil {
		agentLogger.Error("failed to write ready frame", "err", err)
		os.Exit(1)
	}

	host.StartHeartbeat(proto.HeartbeatSendMs * time.Millisecond)

	if idleWatchdog {
		host.StartIdleWatchdog(300 * time.Second)
	}

	host.Run()
}

type hookInfoProvider interface {
	WaitReady(ctx context.Context) error
	SocketPath() string
	Token() string
}

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
			"tabTokens":  true,
		}, nil
	}
}

type runArgs struct {
	root         string
	idleWatchdog bool
	daemonRoot   string
	dialSock     string
	dialRoot     string
}

func parseRunArgs(argv []string) runArgs {
	var args runArgs
	for i := 1; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--idle-watchdog":
			args.idleWatchdog = true
		case "--daemon":
			if i+1 < len(argv) {
				i++
				args.daemonRoot = argv[i]
			}
		case "--dial-workspace":
			if i+1 < len(argv) {
				i++
				args.dialRoot = argv[i]
			}
		case "--dial":
			if i+1 < len(argv) {
				i++
				args.dialSock = argv[i]
			}
		default:
			if args.root == "" && args.daemonRoot == "" && args.dialSock == "" && args.dialRoot == "" {
				args.root = arg
			}
		}
	}
	return args
}

func askpassExitFromArgv(argv []string) (int, bool) {
	if len(argv) >= 3 && argv[1] == "--askpass" {
		return agentgit.RunAskpassHelper(argv[2], argv[3:], os.Stdout, os.Stderr), true
	}
	if socketPath, ok := agentgit.AskpassSocketFromEnv(); ok {
		return agentgit.RunAskpassHelper(socketPath, argv[1:], os.Stdout, os.Stderr), true
	}
	return 0, false
}

func endOrphanedPrograms(root string, logger *slog.Logger) {
	runDir, err := agentpaths.RunDir()
	if err != nil {
		logger.Warn("cannot track chat programs", "err", err)
		return
	}
	ended, err := agentchat.TrackOwnedPrograms(
		filepath.Join(runDir, "programs"),
		agentrun.WsID(root, proto.ServerVersion),
	)
	if len(ended) > 0 {
		logger.Info("ended chat programs a dead agent left running", "pids", ended)
	}
	if err != nil {
		logger.Warn("cannot track chat programs", "err", err)
	}
}
