package pty

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testWorkspaceID = "00000000-0000-0000-0000-000000000001"

// TestSpawnWriteEchoRoundTrip verifies a spawned PTY accepts input and returns child output.
func TestSpawnWriteEchoRoundTrip(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "echo-round-trip"
	spawnTestScript(t, service, tabID, `
stty -echo
echo READY
cat
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	writeSession(t, service, tabID, "hello from renderer\n")
	recorder.requireTranscriptContains(t, "hello from renderer", 2*time.Second)
}

// TestBurstWriteFrameOrderingPreserved verifies sequential write RPCs return in order.
func TestBurstWriteFrameOrderingPreserved(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "burst-order"
	spawnTestScript(t, service, tabID, `
stty -echo
echo READY
cat
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	const frames = 80
	for i := range frames {
		writeSession(t, service, tabID, fmt.Sprintf("FRAME%03d\n", i))
	}
	recorder.requireTranscriptContains(t, "FRAME079", 2*time.Second)

	transcript := recorder.transcript()
	cursor := 0
	for i := range frames {
		marker := fmt.Sprintf("FRAME%03d", i)
		idx := strings.Index(transcript[cursor:], marker)
		if idx < 0 {
			t.Fatalf("missing %s after byte %d in transcript:\n%s", marker, cursor, transcript)
		}
		cursor += idx + len(marker)
	}
}

// TestBackpressureBoundsDataBeforeAck verifies Go pauses before unbounded NDJSON emission.
func TestBackpressureBoundsDataBeforeAck(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "backpressure"
	spawnTestScript(t, service, tabID, `
yes A | head -c 250000
sleep 5
`)

	recorder.requireDataBytesAtLeast(t, HighWatermarkBytes, 2*time.Second)
	withoutAck := recorder.dataBytes()
	if max := HighWatermarkBytes + MaxChunkSize; withoutAck > max {
		t.Fatalf("unacked data exceeded bound: got %d, want <= %d", withoutAck, max)
	}

	time.Sleep(200 * time.Millisecond)
	stillWithoutAck := recorder.dataBytes()
	if stillWithoutAck != withoutAck {
		t.Fatalf("data continued without ack: before=%d after=%d", withoutAck, stillWithoutAck)
	}

	ackBytes := withoutAck - LowWatermarkBytes
	if ackBytes < 0 {
		t.Fatalf("test invariant failed: emitted %d below low watermark", withoutAck)
	}
	ackSession(t, service, tabID, ackBytes)
	recorder.requireDataBytesGreaterThan(t, withoutAck, 2*time.Second)
}

// TestResizeChangesChildReportedGeometry verifies pty.resize reaches child-visible rows and cols.
func TestResizeChangesChildReportedGeometry(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "resize"
	spawnTestScript(t, service, tabID, `
echo READY
trap 'printf "SIZE "; stty size; exit 0' WINCH
while :; do sleep 1; done
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	resizeSession(t, service, tabID, 123, 37)
	recorder.requireTranscriptContains(t, "SIZE 37 123", 2*time.Second)
}

// TestControlCWriteDeliversSIGINT verifies raw 0x03 is handled by the PTY line discipline.
func TestControlCWriteDeliversSIGINT(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "sigint"
	spawnTestScript(t, service, tabID, `
echo READY
exec cat
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	writeSession(t, service, tabID, string([]byte{0x03}))
	exit := recorder.requireExit(t, tabID, 2*time.Second)
	if exit.Signal == nil || *exit.Signal != "SIGINT" {
		t.Fatalf("exit signal mismatch: got %#v, want SIGINT", exit)
	}
	if exit.Code != nil {
		t.Fatalf("signal exit should not carry numeric code: %#v", exit)
	}
}

// TestChildExitCodeEmitted verifies normal non-zero child exits preserve their code.
func TestChildExitCodeEmitted(t *testing.T) {
	service, recorder := newTestService(t)
	tabID := "exit-42"
	spawnTestScript(t, service, tabID, `
exit 42
`)

	exit := recorder.requireExit(t, tabID, 2*time.Second)
	if exit.Code == nil || *exit.Code != 42 {
		t.Fatalf("exit code mismatch: got %#v, want 42", exit)
	}
	if exit.Signal != nil {
		t.Fatalf("normal exit should not carry signal: %#v", exit)
	}
}

// eventRecorder captures PTY push events for focused service tests.
type eventRecorder struct {
	mu      sync.Mutex
	data    [][]byte
	exits   []ExitPayload
	sinkErr error
}

// newTestService creates a PTY service and wires its event sink to a recorder.
func newTestService(t *testing.T) (*Service, *eventRecorder) {
	t.Helper()
	recorder := &eventRecorder{}
	service := New()
	service.SetEventSink(recorder.sink)
	t.Cleanup(service.Close)
	return service, recorder
}

// sink records data and exit events emitted by the service.
func (r *eventRecorder) sink(event string, payload any) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	switch event {
	case EventData:
		data, ok := payload.(DataPayload)
		if !ok {
			r.sinkErr = fmt.Errorf("pty.data payload has type %T", payload)
			return nil
		}
		chunk, err := base64.StdEncoding.DecodeString(data.Chunk)
		if err != nil {
			r.sinkErr = err
			return nil
		}
		r.data = append(r.data, chunk)
	case EventExit:
		exit, ok := payload.(ExitPayload)
		if !ok {
			r.sinkErr = fmt.Errorf("pty.exit payload has type %T", payload)
			return nil
		}
		r.exits = append(r.exits, exit)
	}
	return nil
}

// transcript returns all captured PTY output as one UTF-8 string.
func (r *eventRecorder) transcript() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(bytes.Join(r.data, nil))
}

// dataBytes returns the number of raw output bytes emitted so far.
func (r *eventRecorder) dataBytes() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dataBytesLocked()
}

// dataBytesLocked counts raw output bytes while the recorder mutex is held.
func (r *eventRecorder) dataBytesLocked() int {
	total := 0
	for _, chunk := range r.data {
		total += len(chunk)
	}
	return total
}

// requireTranscriptContains waits until output includes marker.
func (r *eventRecorder) requireTranscriptContains(t *testing.T, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		transcript := string(bytes.Join(r.data, nil))
		err := r.sinkErr
		r.mu.Unlock()
		if err != nil {
			t.Fatalf("event sink failed: %v", err)
		}
		if strings.Contains(transcript, marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q in transcript:\n%s", marker, r.transcript())
}

// requireDataBytesAtLeast waits until at least n raw PTY bytes have been emitted.
func (r *eventRecorder) requireDataBytesAtLeast(t *testing.T, n int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got := r.dataBytes(); got >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for >= %d data bytes; got %d", n, r.dataBytes())
}

// requireDataBytesGreaterThan waits until more than n raw PTY bytes have been emitted.
func (r *eventRecorder) requireDataBytesGreaterThan(t *testing.T, n int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got := r.dataBytes(); got > n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for data bytes > %d; got %d", n, r.dataBytes())
}

// requireExit waits for an exit payload for tabID.
func (r *eventRecorder) requireExit(t *testing.T, tabID string, timeout time.Duration) ExitPayload {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		for _, exit := range r.exits {
			if exit.TabID == tabID {
				r.mu.Unlock()
				return exit
			}
		}
		err := r.sinkErr
		r.mu.Unlock()
		if err != nil {
			t.Fatalf("event sink failed: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for exit event for tab %s", tabID)
	return ExitPayload{}
}

// spawnTestScript writes body to an executable shell script and spawns it as the PTY child.
func spawnTestScript(t *testing.T, service *Service, tabID string, body string) SpawnResult {
	t.Helper()
	path := writeExecutableScript(t, body)
	params := SpawnParams{WorkspaceID: testWorkspaceID, TabID: tabID, Cwd: t.TempDir(), Shell: path, Cols: 80, Rows: 24}
	result, err := service.Spawn(context.Background(), mustJSON(t, params))
	if err != nil {
		t.Fatalf("spawn %s: %v", tabID, err)
	}
	spawned, ok := result.(SpawnResult)
	if !ok {
		t.Fatalf("spawn returned %T, want SpawnResult", result)
	}
	if spawned.PID <= 0 {
		t.Fatalf("spawn pid must be positive: %#v", spawned)
	}
	return spawned
}

// writeExecutableScript creates a temporary executable /bin/sh script.
func writeExecutableScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "child.sh")
	content := "#!/bin/sh\n" + strings.TrimLeft(body, "\n")
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write test script: %v", err)
	}
	return path
}

// writeSession invokes pty.write for tabID.
func writeSession(t *testing.T, service *Service, tabID string, data string) {
	t.Helper()
	_, err := service.Write(context.Background(), mustJSON(t, WriteParams{WorkspaceID: testWorkspaceID, TabID: tabID, Data: data}))
	if err != nil {
		t.Fatalf("write %s: %v", tabID, err)
	}
}

// resizeSession invokes pty.resize for tabID.
func resizeSession(t *testing.T, service *Service, tabID string, cols int, rows int) {
	t.Helper()
	_, err := service.Resize(context.Background(), mustJSON(t, ResizeParams{WorkspaceID: testWorkspaceID, TabID: tabID, Cols: cols, Rows: rows}))
	if err != nil {
		t.Fatalf("resize %s: %v", tabID, err)
	}
}

// ackSession invokes pty.ack for tabID.
func ackSession(t *testing.T, service *Service, tabID string, bytesConsumed int) {
	t.Helper()
	_, err := service.Ack(context.Background(), mustJSON(t, AckParams{WorkspaceID: testWorkspaceID, TabID: tabID, BytesConsumed: bytesConsumed}))
	if err != nil {
		t.Fatalf("ack %s: %v", tabID, err)
	}
}

// mustJSON encodes a request parameter value for direct service calls.
func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return data
}
