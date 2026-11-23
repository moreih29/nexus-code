//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/agentrun"
	agentchat "github.com/nexus-code/nexus-code/internal/chat"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentgit "github.com/nexus-code/nexus-code/internal/git"
	"github.com/nexus-code/nexus-code/internal/hookserver"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
	agentpty "github.com/nexus-code/nexus-code/internal/pty"
	agentsearch "github.com/nexus-code/nexus-code/internal/search"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
	"github.com/nexus-code/nexus-code/internal/sysstat"
)

const ExitCodeLockHeld = 3

const ExitCodeDialFailed = 4

const reattachGrace = 300 * time.Second

const lockRetryWindow = 250 * time.Millisecond

const daemonListeningMessage = "daemon listening"

const shutdownReplyDelay = 100 * time.Millisecond

const preemptedEvent = "agent.preempted"

const preemptedNoticeWithin = 250 * time.Millisecond

const maxRunLogBytes = 1 << 20

func keepHangupsAndInterrupts() {
	dropped := make(chan os.Signal, 1)
	signal.Notify(dropped, syscall.SIGHUP, syscall.SIGINT)
	go func() {
		for range dropped {
		}
	}()
}

func runDaemon(root string) {
	if _, err := syscall.Setsid(); err != nil && err != syscall.EPERM {
		_ = err
	}
	keepHangupsAndInterrupts()

	paths, err := agentrun.For(root, proto.ServerVersion)
	if err != nil {
		os.Exit(1)
	}

	runDir, err := agentpaths.RunDir()
	if err != nil {
		os.Exit(1)
	}
	if err := agentpaths.EnsureDir(runDir); err != nil {
		os.Exit(1)
	}

	_ = agentrun.CapLogSize(paths.Log, maxRunLogBytes)
	logFile, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(1)
	}
	_ = dupStderrToLog(int(logFile.Fd()))

	agentLogger := slog.New(slog.NewJSONHandler(logFile, nil)).With("src", "agent-log")

	lock, err := agentrun.TryLock(paths.Lock)
	for deadline := time.Now().Add(lockRetryWindow); err == agentrun.ErrLockHeld && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
		lock, err = agentrun.TryLock(paths.Lock)
	}
	if err != nil {
		if err == agentrun.ErrLockHeld {
			os.Exit(ExitCodeLockHeld)
		}
		agentLogger.Error("failed to acquire workspace lock", "err", err)
		os.Exit(1)
	}

	if err := paths.EnsureSocketDir(); err != nil {
		agentLogger.Error("daemon socket directory unavailable", "err", err)
		lock.Unlock()
		os.Exit(1)
	}
	if removed := agentrun.SweepStale(runDir, filepath.Dir(paths.Sock), agentrun.WsID(root, proto.ServerVersion)); len(removed) > 0 {
		agentLogger.Info("swept stale run files of dead daemons", "removed", removed)
	}
	endOrphanedPrograms(root, agentLogger)

	if conn, dialErr := net.DialTimeout("unix", paths.Sock, 200*time.Millisecond); dialErr == nil {
		conn.Close()
		lock.Unlock()
		os.Exit(ExitCodeLockHeld)
	}
	_ = os.Remove(paths.Sock)

	agentrun.AdoptAuthSock(paths.AuthSock)

	ln, err := net.Listen("unix", paths.Sock)
	if err != nil {
		agentLogger.Error("daemon listen failed", "path", paths.Sock, "err", err)
		lock.Unlock()
		os.Exit(1)
	}
	if err := os.Chmod(paths.Sock, 0600); err != nil {
		agentLogger.Error("daemon socket chmod failed", "path", paths.Sock, "err", err)
		_ = ln.Close()
		_ = os.Remove(paths.Sock)
		lock.Unlock()
		os.Exit(1)
	}

	fsys, err := agentfs.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize fs", "err", err)
		_ = ln.Close()
		_ = os.Remove(paths.Sock)
		lock.Unlock()
		os.Exit(1)
	}
	git := agentgit.New(root)
	lsp := agentlsp.New()
	pty := agentpty.New()
	chat := agentchat.New()
	search, err := agentsearch.New(root)
	if err != nil {
		agentLogger.Error("failed to initialize search", "err", err)
		_ = ln.Close()
		_ = os.Remove(paths.Sock)
		lock.Unlock()
		os.Exit(1)
	}

	var hooksrv *hookserver.Server
	if hs, hsErr := hookserver.New(hookserver.AgentKey(root), nil); hsErr != nil {
		agentLogger.Warn("hookserver unavailable", "err", hsErr)
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

	epoch := agentrun.NewEpoch()

	var shutdown sync.Once
	releaseWorkspace := func() {
		shutdown.Do(func() {
			pty.Close()
			chat.Close()
			lsp.Close()
			fsys.DropUploads(nil)
			if hooksrv != nil {
				_ = hooksrv.Close()
			}
			_ = ln.Close()
			_ = os.Remove(paths.Sock)
			lock.Unlock()
		})
	}
	cleanupAndExit := func(code int) {
		releaseWorkspace()
		_ = logFile.Close()
		os.Exit(code)
	}

	d.Register("agent.shutdown", func(_ context.Context, _ json.RawMessage) (any, error) {
		agentLogger.Info("daemon shutdown requested")
		releaseWorkspace()
		time.AfterFunc(shutdownReplyDelay, func() { cleanupAndExit(0) })
		return struct{}{}, nil
	})
	d.Register("agent.stopDaemon", newStopDaemonHandler(root))

	nextConn := make(chan net.Conn, 1)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			select {
			case old := <-nextConn:
				_ = old.Close()
			default:
			}
			nextConn <- conn
		}
	}()

	sigtermCh := make(chan os.Signal, 1)
	signal.Notify(sigtermCh, syscall.SIGTERM)
	go func() {
		<-sigtermCh
		signal.Stop(sigtermCh)
		agentLogger.Info("daemon received SIGTERM, shutting down")
		cleanupAndExit(0)
	}()

	serve := func(conn net.Conn) (next net.Conn, keepRunning bool) {
		agentLogger.Info("dialer connected")

		var preempted atomic.Int32

		host := stdioserver.New(d, conn, conn, agentLogger)
		host.RegisterShutdownHook(func() { fsys.DropUploads(host.Context()) })

		if writeErr := host.WriteFrame(proto.Ready(
			d.Methods(),
			proto.HeartbeatAdvertiseMs,
			int(reattachGrace/time.Millisecond),
			epoch,
			[]string{"reattach", agentchat.RunCapability},
		)); writeErr != nil {
			agentLogger.Error("failed to write ready frame", "err", writeErr)
			_ = conn.Close()
			return nil, true
		}

		fsys.SetEventSink(fsEventSink(host, lsp))
		git.SetEventSink(host.EmitEvent)
		lsp.SetEventSink(host.EmitEvent)
		pty.SetEventSink(host.Context(), host.EmitEvent)
		chat.SetConnectionSink(host.Context(), host.EmitEvent)
		search.SetEventSink(host.EmitEvent)
		if hooksrv != nil {
			hooksrv.SetEventSink(host.EmitEvent)
		}

		outcome := make(chan bool, 1)

		hostDone := make(chan struct{})

		host.SetExitFunc(func(code int) {
			keep := false
			switch {
			case preempted.Load() == 1:
				agentLogger.Info("dialer preempted by new connection; daemon continuing")
				keep = true
			case code == 0:
				agentLogger.Info("dialer disconnected cleanly; daemon entering reattach grace")
				keep = true
			case code == stdioserver.TransportErrorExitCode:
				agentLogger.Info("dialer connection broke; daemon entering reattach grace", "code", code)
				keep = true
			default:
				agentLogger.Info("daemon exiting", "code", code)
				cleanupAndExit(code)
			}
			_ = conn.Close()
			if keep && hooksrv != nil {
				hooksrv.ReleaseHooks()
			}
			select {
			case outcome <- keep:
			default:
			}
			close(hostDone)
		})

		host.StartHeartbeat(proto.HeartbeatSendMs * time.Millisecond)
		host.StartIdleWatchdog(reattachGrace)

		takeoverConn := make(chan net.Conn, 1)
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			select {
			case newConn := <-nextConn:
				agentLogger.Info("new dialer arrived; preempting current connection")
				preempted.Store(1)
				_ = host.WriteLastFrame(proto.Event(preemptedEvent, nil), preemptedNoticeWithin)
				_ = conn.Close()
				takeoverConn <- newConn
			case <-hostDone:
			}
		}()

		host.Run()

		<-watchDone
		keep := false
		select {
		case k := <-outcome:
			keep = k
		default:
		}
		var nextDialer net.Conn
		select {
		case c := <-takeoverConn:
			nextDialer = c
		default:
		}
		return nextDialer, keep
	}

	waitForDialer := func(label string) net.Conn {
		select {
		case c := <-nextConn:
			return c
		case <-time.After(reattachGrace):
			agentLogger.Info(label+" grace expired, daemon exiting", "grace", reattachGrace)
			cleanupAndExit(0)
			return nil
		}
	}

	agentLogger.Info(daemonListeningMessage)
	conn := waitForDialer("initial-connect")

	for conn != nil {
		next, keep := serve(conn)
		if !keep {
			return
		}
		conn = next
		if conn == nil {
			conn = waitForDialer("reattach")
		}
	}
}
