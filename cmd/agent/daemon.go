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
// # Grace period
//
// reattachGrace only applies while the daemon is *waiting for a dialer* (idle
// state: first connect or after a clean disconnect). While a dialer is actively
// connected, the acceptor runs without a deadline — otherwise a 300 s session
// would time out the acceptor, permanently disabling takeover and causing the
// next clean-EOF to immediately trigger "grace expired" self-termination.
// Zombie detection during an active connection is handled by the Host's idle
// watchdog, which fires after 300 s of no inbound pings.
//
// # SIGTERM / panic diagnostics
//
// After setsid the SSH terminal is gone. syscall.Dup2 redirects fd 2 to the
// log file so runtime panics and any Go runtime output reach run/<wsId>.log
// rather than /dev/null. slog also writes to the same file via agentLogger.
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

// reattachGrace is the maximum time the daemon waits for a dialer while in
// idle state (first connect or after a clean disconnect / takeover). The
// grace is NOT applied while a dialer is actively serving — that would kill
// long-lived sessions and disable takeover after 300 s of connected use.
const reattachGrace = 300 * time.Second

// maxRunLogBytes caps the append-only run/<wsId>.log at daemon boot.
// 1 MiB of NDJSON boot/lifecycle lines is months of normal use; beyond that
// the log is truncated rather than rotated — see agentrun.CapLogSize.
const maxRunLogBytes = 1 << 20

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
	// The log is append-only and survives every restart, so cap it first —
	// without this a long-lived workspace grows it without bound.
	_ = agentrun.CapLogSize(paths.Log, maxRunLogBytes)
	logFile, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(1)
	}
	// Redirect fd 2 (stderr) to the log file so Go runtime panics and any
	// output written directly to fd 2 (not via slog) also land in the log.
	// Without this, launch scripts that run `agent --daemon ... 2>/dev/null`
	// silently drop panic stacktraces, making crash diagnosis impossible.
	// dupStderrToLog is platform-split: linux/arm64 has no dup2 syscall
	// (dup3 only), while darwin has no dup3 — see dup_linux.go / dup_darwin.go.
	_ = dupStderrToLog(int(logFile.Fd()))

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

	// Step 4b: sweep litter left by dead daemons of OTHER workspaces — stale
	// sockets and over-retention logs. Liveness is decided by flock probing
	// (acquired = provably dead), so a live daemon's files are never touched;
	// see agentrun.SweepStale. Runs after our own lock is held so only one
	// legitimate daemon per workspace ever sweeps.
	if removed := agentrun.SweepStale(runDir, agentrun.WsID(root)); len(removed) > 0 {
		agentLogger.Info("swept stale run files of dead daemons", "removed", removed)
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

	// Accept goroutine: runs for the daemon's entire lifetime with NO deadline.
	// Grace (reattachGrace) is enforced by the main serve loop using time.After
	// at the two idle-wait points (first connect, post-disconnect reattach).
	// This is intentional: applying a deadline inside the acceptor would kill
	// long-lived sessions after 300 s of connected use — the exact scenario that
	// caused the E2E ② regression (daemon born 04:11:40, dead ~04:16:40 = +300 s).
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				// Listener was closed (cleanupAndExit path). Stop quietly.
				return
			}
			// Replace any not-yet-consumed queued conn (rapid reconnect race).
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

		// outcome carries the keep-running decision from the exit function to
		// serve(). Buffer 1 so the exit function never blocks.
		// Only serve() reads from outcome — the watcher goroutine must NOT
		// drain it, or serve()'s select would fall through to default (keep=false).
		outcome := make(chan bool, 1)

		// hostDone is closed by the exit function after writing to outcome.
		// The takeover watcher selects on hostDone instead of outcome so that
		// the outcome value is preserved for serve() to read.
		hostDone := make(chan struct{})

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
			close(hostDone)
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
		// Selects on hostDone (not outcome) to avoid consuming the outcome value
		// that serve() needs to read after host.Run() returns.
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
			case <-hostDone:
				// The host already exited (clean EOF or watchdog). Nothing to do.
			}
		}()

		host.Run()

		// Wait for the watcher to finish, then collect results.
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

	// waitForDialer blocks until a new conn arrives (via nextConn) or the
	// reattach grace window expires. Called at the two idle-wait points:
	// initial first-connect and post-disconnect reattach. Grace is NOT applied
	// while a dialer is active — that is handled by the Host idle watchdog.
	waitForDialer := func(label string) net.Conn {
		select {
		case c := <-nextConn:
			return c
		case <-time.After(reattachGrace):
			agentLogger.Info(label+" grace expired, daemon exiting", "grace", reattachGrace)
			cleanupAndExit(0)
			return nil // unreachable; cleanupAndExit calls os.Exit
		}
	}

	// Main serve loop.
	conn := waitForDialer("initial-connect")

	for conn != nil {
		next, keep := serve(conn)
		if !keep {
			return // cleanupAndExit already called inside serve()
		}
		conn = next
		if conn == nil {
			// serve() exited cleanly (no takeover) — wait for the next dialer.
			conn = waitForDialer("reattach")
		}
	}
}
