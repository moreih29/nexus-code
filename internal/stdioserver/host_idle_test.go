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

func TestIdleWatchdogWaitsForSilence(t *testing.T) {
	t.Parallel()
	host := newTestHost()
	t.Cleanup(host.cancel)
	exited := make(chan int, 1)
	host.exit = func(code int) { exited <- code }
	ticks := make(chan time.Time)
	stopped := make(chan struct{})
	const limit = time.Minute
	host.startIdleWatchdog(limit, func(time.Duration) (<-chan time.Time, func()) {
		return ticks, func() { close(stopped) }
	})
	start := host.startMono.Add(time.Duration(host.lastInbound.Load()))

	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := func(at time.Time) {
		t.Helper()
		select {
		case ticks <- at:
		case code := <-exited:
			t.Fatalf("watchdog exited before tick %s with code %d", at.Sub(start), code)
		case <-deadline.C:
			t.Fatal("watchdog never accepted the tick")
		}
	}
	for i := 1; i <= 6; i++ {
		inbound := start.Add(time.Duration(i) * limit / 2)
		host.stampInbound(inbound)
		tick(inbound.Add(limit / 4))
	}
	last := start.Add(3 * limit)
	tick(last.Add(limit - time.Nanosecond))
	tick(last.Add(limit))
	select {
	case code := <-exited:
		if code != IdleWatchdogExitCode {
			t.Fatalf("exit code = %d, want %d", code, IdleWatchdogExitCode)
		}
	case <-deadline.C:
		t.Fatal("watchdog did not exit at its idle limit")
	}
	<-stopped
}

func TestIdleWatchdogDisabledWhenLimitNonPositive(t *testing.T) {
	host := newTestHost()
	host.startIdleWatchdog(0, func(time.Duration) (<-chan time.Time, func()) {
		t.Fatal("disabled idle watchdog started a ticker")
		return nil, func() {}
	})
}
