//go:build !windows

package pty

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func newBareSession(ringCap int) *session {
	s := &session{
		ring:      make([]byte, ringCap),
		readDone:  make(chan struct{}),
		createdAt: time.Now(),
	}
	return s
}

func ringBytes(s *session) []byte {
	s.ringMu.Lock()
	defer s.ringMu.Unlock()
	if s.ringSize == 0 || s.ring == nil {
		return nil
	}
	cap := len(s.ring)
	out := make([]byte, s.ringSize)
	for i := range s.ringSize {
		out[i] = s.ring[(s.ringHead+i)%cap]
	}
	return out
}

func TestRingFrontDrop(t *testing.T) {
	cap := 8
	s := newBareSession(cap)

	s.ringAppend([]byte("ABCDEFGH"))
	if got := string(ringBytes(s)); got != "ABCDEFGH" {
		t.Fatalf("want ABCDEFGH, got %q", got)
	}

	s.ringAppend([]byte("XY"))
	if got := string(ringBytes(s)); got != "CDEFGHXY" {
		t.Fatalf("after overflow want CDEFGHXY, got %q", got)
	}
}

func TestRingFrontDropExact(t *testing.T) {
	cap := 5
	s := newBareSession(cap)

	for i := 0; i < 6; i++ {
		s.ringAppend([]byte{byte('A' + i)})
	}
	if got := string(ringBytes(s)); got != "BCDEF" {
		t.Fatalf("want BCDEF, got %q", got)
	}
}

func TestRingContentsKeepsOutput(t *testing.T) {
	s := newBareSession(16)
	s.ringAppend([]byte("hello"))

	for range 2 {
		s.ringMu.Lock()
		contents := s.ringContentsLocked()
		s.ringMu.Unlock()
		if string(contents) != "hello" {
			t.Fatalf("contents = %q, want hello", contents)
		}
	}
}

func TestRingContentsStartAtLineOnceDropped(t *testing.T) {
	s := newBareSession(12)
	s.ringAppend([]byte("first line\r\n"))
	s.ringMu.Lock()
	contents := s.ringContentsLocked()
	s.ringMu.Unlock()
	if string(contents) != "first line\r\n" {
		t.Fatalf("before any drop: contents = %q, want the whole output", contents)
	}

	s.ringAppend([]byte("second\r\n"))
	s.ringMu.Lock()
	contents = s.ringContentsLocked()
	s.ringMu.Unlock()
	if string(contents) != "second\r\n" {
		t.Fatalf("after a drop: contents = %q, want second\\r\\n", contents)
	}
}

type sinkRecorder struct {
	mu       sync.Mutex
	chunks   [][]byte
	rejected []byte
	sinkErr  error
}

func (r *sinkRecorder) setSinkErr(err error) {
	r.mu.Lock()
	r.sinkErr = err
	r.mu.Unlock()
}

func (r *sinkRecorder) sink(event string, payload any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var chunk []byte
	if dp, ok := payload.(DataPayload); ok && event == EventData {
		chunk, _ = base64.StdEncoding.DecodeString(dp.Chunk)
	}
	if r.sinkErr != nil {
		r.rejected = append(r.rejected, chunk...)
		return r.sinkErr
	}
	if chunk != nil {
		r.chunks = append(r.chunks, chunk)
	}
	return nil
}

func (r *sinkRecorder) transcript() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(bytes.Join(r.chunks, nil))
}

func (r *sinkRecorder) requireTranscriptContains(t *testing.T, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(r.transcript(), marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %q in transcript:\n%s", marker, r.transcript())
}

func (r *sinkRecorder) requireRejectedContains(t *testing.T, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		found := bytes.Contains(r.rejected, []byte(marker))
		r.mu.Unlock()
		if found {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for the failing sink to be offered %q", marker)
}

func TestAccumulateReplayContentMatch(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(context.Background(), rec.sink)
	t.Cleanup(svc.Close)

	tabID := "replay-match"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
read line
echo BUFFERED
sleep 10
`)
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	rec.setSinkErr(fmt.Errorf("dialer gone"))
	writeSession(t, svc, tabID, "go\n")
	rec.requireRejectedContains(t, "BUFFERED", 2*time.Second)

	rec.setSinkErr(nil)

	_, err := svc.Replay(context.Background(), mustJSON(t, ReplayParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
	}))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}

	rec.requireTranscriptContains(t, "BUFFERED", 2*time.Second)
}

func TestReplayRedrawsDeliveredOutput(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var live, replayed []byte
	svc := New()
	svc.SetEventSink(context.Background(), func(event string, payload any) error {
		dp, ok := payload.(DataPayload)
		if event != EventData || !ok {
			return nil
		}
		chunk, _ := base64.StdEncoding.DecodeString(dp.Chunk)
		mu.Lock()
		defer mu.Unlock()
		if dp.Replay {
			replayed = append(replayed, chunk...)
		} else {
			live = append(live, chunk...)
		}
		return nil
	})
	t.Cleanup(svc.Close)

	tabID := "replay-redraw"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo DELIVERED
sleep 10
`)
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		delivered := bytes.Contains(live, []byte("DELIVERED"))
		mu.Unlock()
		if delivered {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for live DELIVERED")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if _, err := svc.Replay(context.Background(), mustJSON(t, ReplayParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
	})); err != nil {
		t.Fatalf("replay: %v", err)
	}

	mu.Lock()
	got := string(replayed)
	mu.Unlock()
	if !strings.HasPrefix(got, terminalReset) {
		t.Fatalf("replay must start with a terminal reset: %q", got)
	}
	if !strings.Contains(got, "DELIVERED") {
		t.Fatalf("replay must resend delivered output: %q", got)
	}
}

func TestSpawnAttachesToRunningSession(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(context.Background(), rec.sink)
	t.Cleanup(svc.Close)

	tabID := "spawn-attach"
	first := spawnTestScript(t, svc, tabID, `
trap 'printf "SIZE "; stty size' WINCH
echo READY
# Waiting in the wait builtin, not in sleep, lets the trap run at once.
while :; do sleep 1 & wait $!; done
`)
	if first.Attached {
		t.Fatal("first spawn must start a child, not attach")
	}
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	result, err := svc.Spawn(context.Background(), mustJSON(t, SpawnParams{
		WorkspaceID: testWorkspaceID, TabID: tabID, Cwd: t.TempDir(), Cols: 100, Rows: 30,
	}))
	if err != nil {
		t.Fatalf("second spawn: %v", err)
	}
	second, ok := result.(SpawnResult)
	if !ok {
		t.Fatalf("spawn returned %T, want SpawnResult", result)
	}
	if !second.Attached || second.PID != first.PID {
		t.Fatalf("second spawn = %#v, want an attach to pid %d", second, first.PID)
	}
	rec.requireTranscriptContains(t, "SIZE 30 100", 2*time.Second)
}

func TestReplayOrderingNoReversal(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var emitted []string

	failRemaining := 1
	svc := New()
	svc.SetEventSink(context.Background(), func(event string, payload any) error {
		if event != EventData {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if failRemaining > 0 {
			failRemaining--
			return fmt.Errorf("dialer gone")
		}
		if dp, ok := payload.(DataPayload); ok {
			chunk, _ := base64.StdEncoding.DecodeString(dp.Chunk)
			emitted = append(emitted, string(chunk))
		}
		return nil
	})
	t.Cleanup(svc.Close)

	tabID := "replay-order"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo BUFFERED
sleep 0.5
echo LIVE
sleep 5
`)

	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	failRemaining = 0
	mu.Unlock()

	_, err := svc.Replay(context.Background(), mustJSON(t, ReplayParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
	}))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		all := strings.Join(emitted, "")
		mu.Unlock()
		if strings.Contains(all, "LIVE") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	all := strings.Join(emitted, "")
	mu.Unlock()

	if !strings.Contains(all, "BUFFERED") {
		t.Fatalf("BUFFERED not in emitted output: %q", all)
	}
	if !strings.Contains(all, "LIVE") {
		t.Fatalf("LIVE not in emitted output (timed out): %q", all)
	}

	bIdx := strings.Index(all, "BUFFERED")
	lIdx := strings.Index(all, "LIVE")
	if bIdx > lIdx {
		t.Fatalf("ordering reversed: BUFFERED at %d, LIVE at %d in %q", bIdx, lIdx, all)
	}
}

func TestRingReleasedOnSessionExit(t *testing.T) {
	t.Parallel()
	svc := New()
	var mu sync.Mutex
	var exits []ExitPayload
	svc.SetEventSink(context.Background(), func(event string, payload any) error {
		if event == EventExit {
			if ep, ok := payload.(ExitPayload); ok {
				mu.Lock()
				exits = append(exits, ep)
				mu.Unlock()
			}
		}
		return nil
	})
	t.Cleanup(svc.Close)

	tabID := "ring-release"
	key := tabKey{WorkspaceID: testWorkspaceID, TabID: tabID}

	spawnTestScript(t, svc, tabID, `
read line
exit 0
`)

	svc.mu.Lock()
	capturedSess := svc.sessions[key]
	svc.mu.Unlock()
	if capturedSess == nil {
		t.Fatal("could not capture session pointer before exit")
	}
	writeSession(t, svc, tabID, "go\n")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(exits)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	svc.mu.Lock()
	stillInMap := svc.sessions[key]
	svc.mu.Unlock()
	if stillInMap != nil {
		t.Fatal("session still in map after exit — removeSession not called")
	}

	capturedSess.ringMu.Lock()
	ringNil := capturedSess.ring == nil
	capturedSess.ringMu.Unlock()
	if !ringNil {
		t.Fatal("ring not nilled after removeSession — memory will not be reclaimed")
	}
}

func TestSetEventSinkClearsPreviousDialerDebt(t *testing.T) {
	t.Parallel()
	svc := New()

	var mu sync.Mutex
	var afterReset []string
	zombieActive := true
	sink := func(event string, payload any) error {
		if event != EventData {
			return nil
		}
		mu.Lock()
		active := zombieActive
		mu.Unlock()
		if !active {
			if dp, ok := payload.(DataPayload); ok {
				chunk, _ := base64.StdEncoding.DecodeString(dp.Chunk)
				mu.Lock()
				afterReset = append(afterReset, string(chunk))
				mu.Unlock()
			}
		}
		return nil
	}
	svc.SetEventSink(context.Background(), sink)
	t.Cleanup(svc.Close)

	tabID := "zombie-deadlock"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
sleep 10
`)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		result, _ := svc.SessionList(context.Background(), mustJSON(t, SessionListParams{WorkspaceID: testWorkspaceID}))
		if slr, ok := result.(SessionListResult); ok {
			for _, info := range slr.Sessions {
				if info.TabID == tabID {
					goto sessionFound
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("session not found within deadline")
sessionFound:
	key := tabKey{WorkspaceID: testWorkspaceID, TabID: tabID}
	svc.mu.Lock()
	sess := svc.sessions[key]
	svc.mu.Unlock()
	if sess == nil {
		t.Fatal("session not in map")
	}

	svc.mu.Lock()
	sess.outstanding = HighWatermarkBytes
	sess.paused = true
	svc.mu.Unlock()

	mu.Lock()
	zombieActive = false
	mu.Unlock()
	svc.SetEventSink(context.Background(), sink)

	svc.mu.Lock()
	stillPaused := sess.paused
	stillOutstanding := sess.outstanding
	svc.mu.Unlock()
	if stillPaused {
		t.Fatal("paused still true after SetEventSink — readLoop would deadlock")
	}
	if stillOutstanding != 0 {
		t.Fatalf("outstanding = %d after SetEventSink, want 0", stillOutstanding)
	}

	replayCh := make(chan error, 1)
	go func() {
		_, err := svc.Replay(context.Background(), mustJSON(t, ReplayParams{
			WorkspaceID: testWorkspaceID,
			TabID:       tabID,
		}))
		replayCh <- err
	}()

	select {
	case err := <-replayCh:
		if err != nil {
			t.Fatalf("replay error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("replay blocked — zombie deadlock not fixed (SetEventSink had no effect)")
	}
}

func TestReplayWigglesSIGWINCHAfterFlush(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(context.Background(), rec.sink)
	t.Cleanup(svc.Close)

	tabID := "wiggle-sigwinch"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
sleep 10
`)
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	_, err := svc.Resize(context.Background(), mustJSON(t, ResizeParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
		Cols:        80,
		Rows:        24,
	}))
	if err != nil {
		t.Fatalf("resize: %v", err)
	}

	key := tabKey{WorkspaceID: testWorkspaceID, TabID: tabID}
	svc.mu.Lock()
	sess := svc.sessions[key]
	svc.mu.Unlock()
	if sess == nil {
		t.Fatal("session not found after spawn")
	}

	type sizeCall struct{ rows, cols uint16 }
	var callMu sync.Mutex
	var calls []sizeCall
	sess.setSizeFn = func(cols, rows int) error {
		callMu.Lock()
		calls = append(calls, sizeCall{rows: uint16(rows), cols: uint16(cols)})
		callMu.Unlock()
		return sess.master.setSize(cols, rows)
	}

	_, err = svc.Replay(context.Background(), mustJSON(t, ReplayParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
	}))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	var got []sizeCall
	for {
		callMu.Lock()
		got = append([]sizeCall(nil), calls...)
		callMu.Unlock()
		if len(got) >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(got) != 2 {
		t.Fatalf("wiggle: expected 2 Setsize calls, got %d: %v", len(got), got)
	}
	if got[0].rows != 23 || got[0].cols != 80 {
		t.Fatalf("wiggle call 1: want rows=23 cols=80, got rows=%d cols=%d", got[0].rows, got[0].cols)
	}
	if got[1].rows != 24 || got[1].cols != 80 {
		t.Fatalf("wiggle call 2: want rows=24 cols=80, got rows=%d cols=%d", got[1].rows, got[1].cols)
	}
}
