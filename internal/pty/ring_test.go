//go:build !windows

package pty

// ring_test.go — unit tests for the ring buffer, session.list, and pty.replay.
//
// Coverage required by task 11 acceptance (6):
//   (a) Front-drop boundary: when ring is full the oldest bytes are lost and
//       the newest are preserved.
//   (b) Accumulate → replay content match: bytes written to ring while no sink
//       is present appear verbatim in the replay payload.
//   (c) Replay ordering: buffered output precedes live output with no
//       interleaving.
//   (d) Ring released: after session exit removeSession nils the ring slice.
//   (e) Redraw: replay resends output the dialer already received, after a
//       terminal reset, so a client attaching to a running session can draw
//       its screen.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ─── helper: ring-only tests (pure struct, no PTY child) ─────────────────────

// newBareSession returns a session with a small ring cap for boundary testing.
// The child PTY fields are intentionally nil — these tests only exercise ring logic.
func newBareSession(ringCap int) *session {
	s := &session{
		ring:      make([]byte, ringCap),
		readDone:  make(chan struct{}),
		createdAt: time.Now(),
	}
	s.flowCond = sync.NewCond(&s.flowMu)
	return s
}

// ringBytes returns the current valid contents of the ring as a flat slice.
// It does NOT reset the ring; for read-only inspection only.
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

// TestRingFrontDrop verifies that when the ring is full the oldest bytes are
// dropped and the newest are preserved (acceptance 1 / AC-6a).
func TestRingFrontDrop(t *testing.T) {
	cap := 8
	s := newBareSession(cap)

	// Write 'ABCDEFGH' (exactly fills ring).
	s.ringAppend([]byte("ABCDEFGH"))
	if got := string(ringBytes(s)); got != "ABCDEFGH" {
		t.Fatalf("want ABCDEFGH, got %q", got)
	}

	// Write 'XY' — must drop 'AB', keeping 'CDEFGHXY'.
	s.ringAppend([]byte("XY"))
	if got := string(ringBytes(s)); got != "CDEFGHXY" {
		t.Fatalf("after overflow want CDEFGHXY, got %q", got)
	}
}

// TestRingFrontDropExact checks that writing exactly cap+1 bytes results in
// only the last cap bytes being retained.
func TestRingFrontDropExact(t *testing.T) {
	cap := 5
	s := newBareSession(cap)

	// Write 6 bytes one at a time to exercise the per-byte path.
	for i := 0; i < 6; i++ {
		s.ringAppend([]byte{byte('A' + i)})
	}
	// 'A' was dropped; ring should contain 'BCDEF'.
	if got := string(ringBytes(s)); got != "BCDEF" {
		t.Fatalf("want BCDEF, got %q", got)
	}
}

// TestRingContentsKeepsOutput verifies that reading the ring leaves its
// contents in place for the next replay.
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

// TestRingContentsStartAtLineOnceDropped verifies that once the ring has
// dropped older output, its contents start after the first line break, so a
// replay does not begin inside a cut escape sequence or character.
func TestRingContentsStartAtLineOnceDropped(t *testing.T) {
	s := newBareSession(12)
	s.ringAppend([]byte("first line\r\n"))
	s.ringMu.Lock()
	contents := s.ringContentsLocked()
	s.ringMu.Unlock()
	if string(contents) != "first line\r\n" {
		t.Fatalf("before any drop: contents = %q, want the whole output", contents)
	}

	// 8 more bytes drop "first li", leaving "ne\r\nsecond\r\n".
	s.ringAppend([]byte("second\r\n"))
	s.ringMu.Lock()
	contents = s.ringContentsLocked()
	s.ringMu.Unlock()
	if string(contents) != "second\r\n" {
		t.Fatalf("after a drop: contents = %q, want second\\r\\n", contents)
	}
}

// ─── integration tests: accumulate while sink=nil, then replay ───────────────

// sinkRecorder captures emitted events, optionally returning a configured error.
type sinkRecorder struct {
	mu       sync.Mutex
	chunks   [][]byte
	rejected []byte // data offered while sinkErr was set
	sinkErr  error  // if non-nil, returned on every call (simulates dialer absence)
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

// requireTranscriptContains waits until the transcript contains marker.
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

// requireRejectedContains waits until the failing sink has been offered marker.
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

// TestAccumulateReplayContentMatch verifies that output emitted while the sink
// is in error mode ends up in the ring and is replayed verbatim (AC-6b).
func TestAccumulateReplayContentMatch(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(rec.sink)
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

	// Simulate dialer absence by making the sink return an error, then have
	// the child print while it lasts.
	rec.setSinkErr(fmt.Errorf("dialer gone"))
	writeSession(t, svc, tabID, "go\n")
	rec.requireRejectedContains(t, "BUFFERED", 2*time.Second)

	// Reconnect: clear the error and replay.
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

// TestReplayRedrawsDeliveredOutput verifies that replay resends output the
// dialer already received, after a terminal reset and marked as replay, so a
// client that has none of it (a restarted app) can draw the screen (AC-6e).
func TestReplayRedrawsDeliveredOutput(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var live, replayed []byte
	svc := New()
	svc.SetEventSink(func(event string, payload any) error {
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

// TestSpawnAttachesToRunningSession verifies that spawning a tab whose session
// is still running reports the attach and fits the session to the new
// client's size instead of starting another child.
func TestSpawnAttachesToRunningSession(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(rec.sink)
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

// TestReplayOrderingNoReversal verifies that buffered (ring) output is delivered
// before any live output produced after replay starts, with no interleaving
// (AC-6c).
//
// The test uses a mock session to decouple from real PTY timing.
func TestReplayOrderingNoReversal(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var emitted []string

	// failOnce: the first N calls return an error (simulating dialer absence),
	// then succeed.
	failRemaining := 1 // fail the first emit call
	svc := New()
	svc.SetEventSink(func(event string, payload any) error {
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
	// Script prints BUFFERED, pauses, prints LIVE.
	spawnTestScript(t, svc, tabID, `
stty -echo
echo BUFFERED
sleep 0.5
echo LIVE
sleep 5
`)

	// Wait for BUFFERED to land in ring (readLoop got an error on first emit).
	time.Sleep(200 * time.Millisecond)

	// Reconnect by switching to a working sink; replay flushes ring.
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

	// Wait for LIVE to arrive via normal readLoop.
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

	// BUFFERED must appear before LIVE — no order reversal.
	bIdx := strings.Index(all, "BUFFERED")
	lIdx := strings.Index(all, "LIVE")
	if bIdx > lIdx {
		t.Fatalf("ordering reversed: BUFFERED at %d, LIVE at %d in %q", bIdx, lIdx, all)
	}
}

// TestRingReleasedOnSessionExit verifies that removeSession removes the session
// from the map and nils the ring slice, allowing GC (AC-6d).
func TestRingReleasedOnSessionExit(t *testing.T) {
	t.Parallel()
	svc := New()
	var mu sync.Mutex
	var exits []ExitPayload
	svc.SetEventSink(func(event string, payload any) error {
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
	// Hold a direct reference to the session so we can inspect ring after removal.
	key := tabKey{workspaceID: testWorkspaceID, tabID: tabID}

	spawnTestScript(t, svc, tabID, `exit 0`)

	// Capture the session pointer right after spawn (before it exits).
	var capturedSess *session
	for i := 0; i < 50; i++ {
		svc.mu.Lock()
		capturedSess = svc.sessions[key]
		svc.mu.Unlock()
		if capturedSess != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if capturedSess == nil {
		t.Fatal("could not capture session pointer before exit")
	}

	// Wait for exit event.
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

	// Session must have been removed from the map.
	svc.mu.Lock()
	stillInMap := svc.sessions[key]
	svc.mu.Unlock()
	if stillInMap != nil {
		t.Fatal("session still in map after exit — removeSession not called")
	}

	// ring must have been nilled by removeSession so GC can reclaim 1 MiB.
	capturedSess.ringMu.Lock()
	ringNil := capturedSess.ring == nil
	capturedSess.ringMu.Unlock()
	if !ringNil {
		t.Fatal("ring not nilled after removeSession — memory will not be reclaimed")
	}
}

// TestSessionListReturnsLiveSessions verifies session.list reports running tabs.
func TestSessionListReturnsLiveSessions(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(rec.sink)
	t.Cleanup(svc.Close)

	tabID := "list-live"
	spawnTestScript(t, svc, tabID, `
echo READY
sleep 10
`)
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	result, err := svc.SessionList(context.Background(), mustJSON(t, SessionListParams{
		WorkspaceID: testWorkspaceID,
	}))
	if err != nil {
		t.Fatalf("session.list: %v", err)
	}
	slr, ok := result.(SessionListResult)
	if !ok {
		t.Fatalf("wrong result type %T", result)
	}
	found := false
	for _, info := range slr.Sessions {
		if info.TabID == tabID && info.WorkspaceID == testWorkspaceID {
			found = true
			if info.CreatedAt <= 0 {
				t.Fatalf("createdAt must be positive, got %d", info.CreatedAt)
			}
		}
	}
	if !found {
		// Marshal the result for a helpful diagnostic.
		b, _ := json.Marshal(slr)
		t.Fatalf("tabID %q not in session.list result: %s", tabID, b)
	}
}

// TestSessionListEmptyWhenNoSessions verifies session.list returns an empty
// slice (not nil) when no sessions exist, so the JSON field is always an array.
func TestSessionListEmptyWhenNoSessions(t *testing.T) {
	svc := New()
	result, err := svc.SessionList(context.Background(), mustJSON(t, SessionListParams{}))
	if err != nil {
		t.Fatalf("session.list: %v", err)
	}
	slr, ok := result.(SessionListResult)
	if !ok {
		t.Fatalf("wrong result type %T", result)
	}
	if slr.Sessions == nil {
		t.Fatal("sessions must be non-nil empty slice, got nil")
	}
	if len(slr.Sessions) != 0 {
		t.Fatalf("expected empty, got %d sessions", len(slr.Sessions))
	}
}

// TestResetFlowControlUnblocksZombieDeadlock verifies the fix for the zombie
// window deadlock scenario:
//
//  1. noteEmitted accumulates debt past HighWatermarkBytes without matching acks
//     (simulating a zombie dialer whose OS socket buffer absorbs writes).
//  2. readLoop blocks in waitForOutputWindow — paused=true.
//  3. ResetFlowControl is called (simulating a new dialer wiring its sink).
//  4. pty.replay completes successfully and live output resumes.
//
// Without the fix, step 4 would block forever because emitBytes calls
// waitForOutputWindow which re-enters the same paused condition.
func TestResetFlowControlUnblocksZombieDeadlock(t *testing.T) {
	t.Parallel()
	// Phase 1: spawn a PTY that produces continuous output, then drive
	// noteEmitted past HighWatermarkBytes without any acks.
	svc := New()

	// Sink that succeeds but never triggers acks — models the OS buffer
	// absorbing writes while the zombie dialer is alive.
	var mu sync.Mutex
	var afterReset []string
	zombieActive := true
	svc.SetEventSink(func(event string, payload any) error {
		if event != EventData {
			return nil
		}
		mu.Lock()
		active := zombieActive
		mu.Unlock()
		if !active {
			// Post-reset: record received chunks for assertion.
			if dp, ok := payload.(DataPayload); ok {
				chunk, _ := base64.StdEncoding.DecodeString(dp.Chunk)
				mu.Lock()
				afterReset = append(afterReset, string(chunk))
				mu.Unlock()
			}
		}
		return nil
	})
	t.Cleanup(svc.Close)

	tabID := "zombie-deadlock"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
sleep 10
`)

	// Wait for READY so we know the session is registered.
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

	// Directly manipulate the session's flow state to simulate the zombie window:
	// set outstanding to HighWatermarkBytes and paused=true, as if noteEmitted
	// accumulated that debt without any acks arriving.
	key := tabKey{workspaceID: testWorkspaceID, tabID: tabID}
	svc.mu.Lock()
	sess := svc.sessions[key]
	svc.mu.Unlock()
	if sess == nil {
		t.Fatal("session not in map")
	}

	sess.flowMu.Lock()
	sess.outstanding = HighWatermarkBytes
	sess.paused = true
	sess.flowMu.Unlock()

	// Phase 2: simulate new dialer wiring — ResetFlowControl must unblock.
	mu.Lock()
	zombieActive = false
	mu.Unlock()
	svc.ResetFlowControl()

	// Phase 3: verify the flow gate is now open.
	sess.flowMu.Lock()
	stillPaused := sess.paused
	stillOutstanding := sess.outstanding
	sess.flowMu.Unlock()
	if stillPaused {
		t.Fatal("paused still true after ResetFlowControl — readLoop would deadlock")
	}
	if stillOutstanding != 0 {
		t.Fatalf("outstanding = %d after ResetFlowControl, want 0", stillOutstanding)
	}

	// Phase 4: replay must complete without blocking (would time out if paused).
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
		t.Fatal("replay blocked — zombie deadlock not fixed (ResetFlowControl had no effect)")
	}
}

// TestReplayWigglesSIGWINCHAfterFlush verifies that pty.replay issues a
// rows-1 → hold → original-rows Setsize sequence after completing the
// live-queue flush (AC patch).
//
// The sequence is verified via a setSizeFn stub injected into the session:
//   - Call 1 must set rows = lastRows-1 (shrink).
//   - Call 2 must set rows = lastRows    (restore, after wiggleRestoreDelay).
//
// Using a stub avoids the Unix signal-coalescing race that makes counting
// SIGWINCH receipts from a shell trap unreliable: the kernel may merge two
// rapid SIGWINCH deliveries into one pending signal while the first handler
// is executing.  That same coalescing is why production code holds the
// shrunken size for wiggleRestoreDelay before restoring — and why this test
// polls for the second call instead of asserting synchronously: the wiggle
// runs in a goroutine so the replay RPC is not delayed by the hold.
func TestReplayWigglesSIGWINCHAfterFlush(t *testing.T) {
	t.Parallel()
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(rec.sink)
	t.Cleanup(svc.Close)

	tabID := "wiggle-sigwinch"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
sleep 10
`)
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	// Record a size so wiggleSIGWINCH has rows > 1.
	_, err := svc.Resize(context.Background(), mustJSON(t, ResizeParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
		Cols:        80,
		Rows:        24,
	}))
	if err != nil {
		t.Fatalf("resize: %v", err)
	}

	// Inject a setSizeFn stub into the session to record Setsize call arguments
	// without relying on asynchronous SIGWINCH delivery to the shell.
	key := tabKey{workspaceID: testWorkspaceID, tabID: tabID}
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
		// Also apply the real resize so the PTY fd stays consistent.
		return sess.master.setSize(cols, rows)
	}

	// Replay (ring empty is fine — wiggle runs regardless of ring content).
	_, err = svc.Replay(context.Background(), mustJSON(t, ReplayParams{
		WorkspaceID: testWorkspaceID,
		TabID:       tabID,
	}))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}

	// The wiggle runs in a goroutine and holds the shrunken size for
	// wiggleRestoreDelay before restoring — poll until both calls land.
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
	// First call must shrink by exactly one row.
	if got[0].rows != 23 || got[0].cols != 80 {
		t.Fatalf("wiggle call 1: want rows=23 cols=80, got rows=%d cols=%d", got[0].rows, got[0].cols)
	}
	// Second call must restore the original size.
	if got[1].rows != 24 || got[1].cols != 80 {
		t.Fatalf("wiggle call 2: want rows=24 cols=80, got rows=%d cols=%d", got[1].rows, got[1].cols)
	}
}
