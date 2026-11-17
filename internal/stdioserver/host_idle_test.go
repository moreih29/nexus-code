// Package stdioserver — idle watchdog tests.
//
// StartIdleWatchdog must self-terminate the agent when the client stops
// sending (vanished client, half-open link) but must never fire while inbound
// traffic keeps arriving. We inject a fake exit so termination is observable
// without killing the test runner.
package stdioserver

import (
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

func newTestHost() *Host {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(dispatch.New(), strings.NewReader(""), io.Discard, logger)
}

// Watchdog fires when no inbound line arrives within the limit.
func TestIdleWatchdogExitsWhenClientVanishes(t *testing.T) {
	host := newTestHost()
	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	host.StartIdleWatchdog(30 * time.Millisecond)

	select {
	case code := <-exited:
		// Non-zero (EX_TEMPFAIL) so the client reconnects instead of treating
		// the close as a clean shutdown.
		if code != IdleWatchdogExitCode {
			t.Fatalf("exit code = %d, want %d", code, IdleWatchdogExitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("idle watchdog did not terminate within 2s of client silence")
	}
}

// Watchdog must NOT fire while inbound lines keep resetting lastInbound.
//
// The window runs three limits, so a watchdog that ignored the traffic would
// fire in it. The limit is many times the stamping interval so that a busy CI
// runner stalling this goroutine for a while does not read as client silence:
// a 60ms limit with 20ms stamps failed on macOS runners.
func TestIdleWatchdogStaysAliveWithTraffic(t *testing.T) {
	host := newTestHost()
	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	const limit = 400 * time.Millisecond
	host.StartIdleWatchdog(limit)

	stop := time.After(3 * limit)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			host.stampInbound()
		case code := <-exited:
			t.Fatalf("watchdog fired during active traffic (code=%d)", code)
		case <-stop:
			return // survived the window without firing
		}
	}
}

// A non-positive limit disables the watchdog entirely.
func TestIdleWatchdogDisabledWhenLimitNonPositive(t *testing.T) {
	host := newTestHost()
	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	host.StartIdleWatchdog(0)

	select {
	case <-exited:
		t.Fatal("watchdog fired despite a non-positive (disabled) limit")
	case <-time.After(100 * time.Millisecond):
		// expected: no termination
	}
}
