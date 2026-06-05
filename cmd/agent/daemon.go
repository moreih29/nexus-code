// daemon.go implements the `agent --daemon <rootPath>` execution path.
//
// The daemon detaches from the SSH session (setsid + SIGHUP ignore), acquires
// a workspace-scoped flock, binds a Unix socket, and runs the NDJSON server
// loop per connected dialer. Its stderr is redirected to run/<wsId>.log so
// boot failures remain diagnosable after the controlling terminal is gone.
//
// # Single-dialer takeover invariant
//
// At most one dialer is active at a time, but a new incoming connection always
// wins over the current one — it closes the existing conn and takes over as
// the active dialer. This is critical for the silent-disconnect scenario (docker
// pause, cable pull, sshd TCP-keepalive timeout): the old dialer may be a
// zombie that never sends EOF, while the new connection represents the genuine
// client returning. Rejecting the second connection would leave the client
// blocked waiting for a Ready frame that never comes; 300 s later the watchdog
// would kill the daemon and all PTYs — exactly when reattach is most needed.
//
// The accept goroutine runs continuously alongside serve(). When a new conn
// arrives while a dialer is active, a watcher goroutine inside serve() closes
// the current conn (marking it "preempted") so host.Run() exits via a transport
// error. The exit function sees the preempted flag and treats it as a clean
// disconnect rather than a daemon shutdown.
//
// # Lifetimes
//
// CRITICAL: dialer disconnect ≠ daemon exit.
// A clean dialer EOF (code 0) or a takeover (code 74 with preempted=true)
// leave PTYs intact. PTYs are killed only when the daemon itself exits — either
// because no new dialer arrives within 300 s, the idle watchdog fires, or
// SIGTERM arrives.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/agentrun"
	"github.com/nexus-code/nexus-code/internal/dispatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentgit "github.com/nexus-code/nexus-code/internal/git"
	"github.com/nexus-code/nexus-code/internal/hookserver"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
	agentpty "github.com/nexus-code/nexus-code/internal/pty"
	agentsearch "github.com/nexus-code/nexus-code/internal/search"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

// ExitCodeLockHeld is returned when `--daemon` cannot acquire the workspace
// lock because another daemon is already running. The launcher should switch
// to `--dial` mode rather than treating this as a fatal error.
const ExitCodeLockHeld = 3

// ExitCodeDialFailed is returned when `--dial` cannot connect to the daemon
// socket. The launcher knows no daemon is present and should start one first.
const ExitCodeDialFailed = 4

// reattachGrace is the maximum time the daemon waits for a dialer — both
// for the very first connection and for reattach after disconnect. If no
// dialer arrives within this window, the daemon self-terminates, reaping
// all PTY children.
const reattachGrace = 300 * time.Second

// runDaemon is the `agent --daemon <root>` entry point. It never returns —
// the process exits via cleanupAndExit, the idle watchdog, or a fatal error.
func runDaemon(root string) {
	// Step 1: detach from the SSH session's process group and controlling
	// terminal. setsid(2) creates a new session where this process is both
	// session leader and process group leader, cutting the tie to sshd.
	// syscall.Setsid() is the portable Go wrapper (linux + darwin); EPERM
	// means we are already a session leader, which is harmless.
	// signal.Ignore(SIGHUP) adds belt-and-suspenders: even if a SIGHUP is
	// somehow delivered it will not kill the daemon.
	if _, err := syscall.Setsid(); err != nil && err != syscall.EPERM {
		// Only truly unexpected errors are worth noting; EPERM is the normal
		// "already a session leader" result in some container runtimes.
		_ = err
	}
	signal.Ignore(syscall.SIGHUP)

	// Step 2: resolve per-workspace runtime file paths.
	paths, err := agentrun.For(root)
	if err != nil {
		os.Exit(1)
	}

	// Ensure the run directory exists (0700) before touching files inside it.
	runDir, err := agentpaths.RunDir()
	if err != nil {
		os.Exit(1)
	}
	if err := agentpaths.EnsureDir(runDir); err != nil {
		os.Exit(1)
	}

	// Step 3: redirect stderr to the run log file. After setsid the SSH
	// terminal is gone; the log file is the only place boot errors land.
	logFile, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(1)
	}
	agentLogger := slog.New(slog.NewJSONHandler(logFile, nil)).With("src", "agent-log")

	// Step 4: acquire the workspace lock. A second daemon for the same
	// workspace cannot acquire it and exits with ExitCodeLockHeld, prompting
	// the launcher to switch to dialer mode.
	lock, err := agentrun.TryLock(paths.Lock)
	if err != nil {
		if err == agentrun.ErrLockHeld {
			os.Exit(ExitCodeLockHeld)
		}
		agentLogger.Error("failed to acquire workspace lock", "err", err)
		os.Exit(1)
	}

	// Step 5: stale socket check.
	// Attempt a brief connect to the existing socket path:
	//   - Success: another daemon is answering — we are redundant, yield.
	//   - Any error: stale or absent socket; unlink and proceed.
	if conn, dialErr := net.DialTimeout("unix", paths.Sock, 200*time.Millisecond); dialErr == nil {
		conn.Close()
		lock.Unlock()
		os.Exit(ExitCodeLockHeld)
	}
	_ = os.Remove(paths.Sock) // remove stale socket file if present

	// Step 6: bind the Unix socket. The run directory (0700) is already
	// ensured above; explicit socket chmod 0600 guards against any umask.
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

	// Step 7: boot shared services. These persist for the daemon's entire
	// lifetime and survive dialer reconnects — a reattaching dialer picks up
	// the same PTYs, LSP sessions, and file watches.
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
	agentsearch.Register(d, search)
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

	// agentEpoch identifies this daemon boot. The TS client compares it on
	// reattach: a mismatch means the daemon was replaced and any queued
	// reconnect state must be discarded.
	epoch := agentrun.NewEpoch()

	// cleanupAndExit tears down all shared resources and terminates.
	// Called only on genuine daemon shutdown — not on dialer disconnect.
	// The pty.Close call here is the service.go:79-91 path (SIGKILL all PTYs).
	cleanupAndExit := func(code int) {
		pty.Close() // SIGKILL every PTY process group
		if hooksrv != nil {
			_ = hooksrv.Close()
		}
		_ = ln.Close()
		_ = os.Remove(paths.Sock)
		lock.Unlock()
		_ = logFile.Close()
		os.Exit(code)
	}

	// nextConn delivers incoming connections from the accept goroutine to the
	// serve loop. Buffer of 1 so the acceptor never blocks while serve is busy.
	nextConn := make(chan net.Conn, 1)
	// graceExpired is closed by the accept goroutine when the reattachGrace
	// deadline fires with no incoming connection.
	graceExpired := make(chan struct{})

	// Accept goroutine: runs for the daemon's entire lifetime. Every call to
	// Accept uses a reattachGrace deadline — this applies to the very first
	// connection too (CRITICAL 2), so a launcher that starts the daemon then
	// crashes before dialing does not leave an orphan daemon.
	go func() {
		unixLn := ln.(*net.UnixListener)
		for {
			_ = unixLn.SetDeadline(time.Now().Add(reattachGrace))
			conn, err := unixLn.Accept()
			_ = unixLn.SetDeadline(time.Time{})
			if err != nil {
				// Deadline expired (grace elapsed) or listener closed.
				// Either way: no dialer arrived within the grace window.
				close(graceExpired)
				return
			}
			// Replace any not-yet-consumed queued conn. This can happen if
			// a second connection arrives while the serve loop is in the middle
			// of a takeover.
			select {
			case old := <-nextConn:
				_ = old.Close()
			default:
			}
			nextConn <- conn
		}
	}()

	// SIGTERM handler: installed once for the daemon's lifetime.
	sigtermCh := make(chan os.Signal, 1)
	signal.Notify(sigtermCh, syscall.SIGTERM)
	go func() {
		<-sigtermCh
		signal.Stop(sigtermCh)
		agentLogger.Info("daemon received SIGTERM, shutting down")
		cleanupAndExit(0)
	}()

	// serve runs one NDJSON Host lifecycle over conn and returns when the host
	// exits. Returns (next, true) when the daemon should serve next dialer conn,
	// (nil, false) when the daemon should exit (cleanupAndExit already called).
	//
	// preempted is set to 1 just before conn is closed from outside (takeover)
	// so the exit function can distinguish "takeover transport error" (keep
	// running) from a genuine watchdog / transport failure (exit daemon).
	serve := func(conn net.Conn) (next net.Conn, keepRunning bool) {
		agentLogger.Info("dialer connected")

		var preempted atomic.Int32

		host := stdioserver.New(d, conn, conn, agentLogger)

		// Wire event sinks to this host. On the next dialer, they are re-wired.
		fsys.SetEventSink(func(event string, payload any) error {
			emitErr := host.EmitEvent(event, payload)
			if event == "fs.changed" {
				if changed, ok := payload.(agentfs.FsChangedPayload); ok {
					if routeErr := lsp.HandleFSChanged(changed); emitErr == nil {
						emitErr = routeErr
					}
				}
			}
			return emitErr
		})
		git.SetEventSink(host.EmitEvent)
		lsp.SetEventSink(host.EmitEvent)
		pty.SetEventSink(host.EmitEvent)
		search.SetEventSink(host.EmitEvent)
		if hooksrv != nil {
			hooksrv.SetEventSink(host.EmitEvent)
		}

		// outcome signals whether the daemon should keep running after this
		// serve call ends.
		outcome := make(chan bool, 1)

		host.SetExitFunc(func(code int) {
			keep := false
			switch {
			case code == 0:
				// Clean dialer EOF — daemon stays alive for reattach.
				// CRITICAL: PTYs must NOT be killed here.
				agentLogger.Info("dialer disconnected cleanly; daemon entering reattach grace")
				keep = true
			case preempted.Load() == 1:
				// This conn was closed by a takeover (new dialer arrived).
				// The resulting transport read error (code 74) is expected.
				// CRITICAL: PTYs must NOT be killed here.
				agentLogger.Info("dialer preempted by new connection; daemon continuing")
				keep = true
			default:
				// Watchdog fired (75) or genuine transport error without a
				// concurrent takeover — real daemon shutdown.
				agentLogger.Info("daemon exiting", "code", code)
				cleanupAndExit(code)
			}
			_ = conn.Close()
			select {
			case outcome <- keep:
			default:
			}
		})

		if writeErr := host.WriteFrame(proto.Ready(
			d.Methods(),
			5_000,
			int(reattachGrace/time.Millisecond),
			epoch,
			[]string{"reattach"},
		)); writeErr != nil {
			agentLogger.Error("failed to write ready frame", "err", writeErr)
			_ = conn.Close()
			return nil, true // keep running; dialer may reconnect
		}

		host.StartHeartbeat(5 * time.Second)
		// The idle watchdog fires after reattachGrace of no inbound traffic.
		// While a live dialer is connected, its pings keep resetting the timer.
		// A silent zombie dialer (dead TCP, no EOF) trips the watchdog after
		// 300 s — by which time a live client would have reconnected via
		// takeover. Watchdog expiry therefore means genuine abandonment.
		host.StartIdleWatchdog(reattachGrace)

		// Takeover watcher: while host.Run() is blocked, watch for a new conn
		// arriving on nextConn. When it does, mark the current conn preempted
		// and close it so host.Run() exits via transport read error (code 74).
		// The new conn is returned to the caller for the next serve call.
		takeoverConn := make(chan net.Conn, 1)
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			select {
			case newConn := <-nextConn:
				agentLogger.Info("new dialer arrived; preempting current connection")
				preempted.Store(1)
				_ = conn.Close() // causes host scanner to get read error → exit 74
				takeoverConn <- newConn
			case <-outcome:
				// The host already exited (clean EOF or watchdog). Nothing to do.
			}
		}()

		host.Run()

		// Drain outcome and watcher.
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

	// Main serve loop.
	// Block until the first conn arrives (or grace expires).
	var conn net.Conn
	select {
	case c := <-nextConn:
		conn = c
	case <-graceExpired:
		agentLogger.Info("no initial dialer within grace period, daemon exiting")
		cleanupAndExit(0)
		return
	}

	for conn != nil {
		next, keep := serve(conn)
		if !keep {
			return // cleanupAndExit already called inside serve()
		}
		conn = next
		if conn == nil {
			// serve() exited cleanly (no takeover) — wait for the next dialer.
			select {
			case c := <-nextConn:
				conn = c
			case <-graceExpired:
				agentLogger.Info("reattach grace expired, daemon exiting")
				cleanupAndExit(0)
				return
			}
		}
	}
}
