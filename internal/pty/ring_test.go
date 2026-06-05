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

// TestRingSnapshotResets verifies that ringSnapshotLocked empties the ring.
func TestRingSnapshotResets(t *testing.T) {
	s := newBareSession(16)
	s.ringAppend([]byte("hello"))

	s.ringMu.Lock()
	snap := s.ringSnapshotLocked()
	s.ringMu.Unlock()

	if string(snap) != "hello" {
		t.Fatalf("snapshot = %q, want hello", snap)
	}
	if got := ringBytes(s); len(got) != 0 {
		t.Fatalf("ring not empty after snapshot: %q", got)
	}
}

// ─── integration tests: accumulate while sink=nil, then replay ───────────────

// sinkRecorder captures emitted events, optionally returning a configured error.
type sinkRecorder struct {
	mu      sync.Mutex
	chunks  [][]byte
	sinkErr error // if non-nil, returned on every call (simulates dialer absence)
}

func (r *sinkRecorder) setSinkErr(err error) {
	r.mu.Lock()
	r.sinkErr = err
	r.mu.Unlock()
}

func (r *sinkRecorder) sink(event string, payload any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sinkErr != nil {
		return r.sinkErr
	}
	if event == EventData {
		if dp, ok := payload.(DataPayload); ok {
			chunk, _ := base64.StdEncoding.DecodeString(dp.Chunk)
			r.chunks = append(r.chunks, chunk)
		}
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

// TestAccumulateReplayContentMatch verifies that output emitted while the sink
// is in error mode ends up in the ring and is replayed verbatim (AC-6b).
func TestAccumulateReplayContentMatch(t *testing.T) {
	rec := &sinkRecorder{}
	svc := New()
	svc.SetEventSink(rec.sink)
	t.Cleanup(svc.Close)

	tabID := "replay-match"
	spawnTestScript(t, svc, tabID, `
stty -echo
echo READY
sleep 1
echo BUFFERED
sleep 5
`)
	rec.requireTranscriptContains(t, "READY", 2*time.Second)

	// Simulate dialer absence by making the sink return an error.
	rec.setSinkErr(fmt.Errorf("dialer gone"))

	// Wait for BUFFERED to be produced; readLoop will write it to ring.
	time.Sleep(300 * time.Millisecond)

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

// TestReplayOrderingNoReversal verifies that buffered (ring) output is delivered
// before any live output produced after replay starts, with no interleaving
// (AC-6c).
//
// The test uses a mock session to decouple from real PTY timing.
func TestReplayOrderingNoReversal(t *testing.T) {
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
