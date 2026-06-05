// Package stdioserver — watchdog 300 s reattach grace tests.
//
// Validates that the idle watchdog correctly represents the 300 s reattach
// grace period semantics introduced in task 10: the watchdog fires only
// after 300 s of silence, keeping it configurable for injection in tests.
package stdioserver

import (
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// TestWatchdog300sSemantics verifies that a watchdog configured with a large
// limit does NOT fire if inbound traffic keeps arriving — matching the daemon
// reattach grace period scenario where pings from the active dialer reset the
// timer. Uses a short synthetic limit so the test runs quickly.
func TestWatchdog300sSemantics(t *testing.T) {
	// The 300 s constant in daemon.go is exercised end-to-end in integration;
	// here we validate the mechanism: limit=80ms, traffic every 20ms → no fire.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	host := New(dispatch.New(), strings.NewReader(""), io.Discard, logger)

	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	host.StartIdleWatchdog(80 * time.Millisecond)

	stop := time.After(320 * time.Millisecond)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			host.stampInbound() // simulate dialer pings
		case code := <-exited:
			t.Fatalf("watchdog fired during active pings (code=%d) — reattach grace violated", code)
		case <-stop:
			return // survived without firing
		}
	}
}

// TestWatchdogFiresAfterDialerSilence verifies that when pings stop (dialer
// disconnected), the watchdog fires after the configured limit. This is the
// "300 s no-reattach → self-termination" path in the daemon.
func TestWatchdogFiresAfterDialerSilence(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	host := New(dispatch.New(), strings.NewReader(""), io.Discard, logger)

	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	host.StartIdleWatchdog(40 * time.Millisecond)

	select {
	case code := <-exited:
		if code != idleWatchdogExitCode {
			t.Fatalf("exit code = %d, want %d (EX_TEMPFAIL)", code, idleWatchdogExitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not fire after dialer went silent")
	}
}

// TestSetExitFuncOverride verifies that SetExitFunc replaces the exit function
// so the daemon can intercept code 0 (clean dialer disconnect) without calling
// os.Exit — the core mechanism for keeping the daemon alive after EOF.
func TestSetExitFuncOverride(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	host := New(dispatch.New(), strings.NewReader(""), io.Discard, logger)

	intercepted := make(chan int, 1)
	host.SetExitFunc(func(code int) {
		intercepted <- code
	})

	// Trigger drainAndExit(0) which the daemon maps to "clean dialer disconnect".
	host.drainAndExit(0)

	select {
	case code := <-intercepted:
		if code != 0 {
			t.Fatalf("intercepted exit code = %d, want 0", code)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("SetExitFunc override was not called by drainAndExit")
	}
}
