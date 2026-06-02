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
		if code != idleWatchdogExitCode {
			t.Fatalf("exit code = %d, want %d", code, idleWatchdogExitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("idle watchdog did not terminate within 2s of client silence")
	}
}

// Watchdog must NOT fire while inbound lines keep resetting lastInbound.
func TestIdleWatchdogStaysAliveWithTraffic(t *testing.T) {
	host := newTestHost()
	exited := make(chan int, 1)
	host.exit = func(code int) {
		select {
		case exited <- code:
		default:
		}
	}

	host.StartIdleWatchdog(60 * time.Millisecond)

	stop := time.After(240 * time.Millisecond)
	tick := time.NewTicker(20 * time.Millisecond)
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
