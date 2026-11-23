//go:build !windows

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
	"syscall"
	"testing"
	"time"
)

const testWorkspaceID = "00000000-0000-0000-0000-000000000001"

func TestConcurrentWritesKeepFramesWhole(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	tabID := "burst-order"
	spawnTestScript(t, service, tabID, `
stty raw -echo
printf READY
exec cat
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	a := strings.Repeat("A", 32*maxWriteChunkSize)
	b := strings.Repeat("B", 32*maxWriteChunkSize)
	start := make(chan struct{})
	done := make(chan error, 2)
	for _, frame := range []string{a, b} {
		params := mustJSON(t, WriteParams{WorkspaceID: testWorkspaceID, TabID: tabID, Data: frame})
		go func() {
			<-start
			_, err := service.Write(context.Background(), params)
			done <- err
		}()
	}
	close(start)
	recorder.requireDataBytesAtLeast(t, len("READY")+len(a)+len(b), 2*time.Second)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if got := strings.TrimPrefix(recorder.transcript(), "READY"); got != a+b && got != b+a {
		t.Fatalf("PTY input frames interleaved or changed: got %d bytes", len(got))
	}
}

func TestBackpressureBoundsDataBeforeAck(t *testing.T) {
	t.Parallel()
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

func TestResizeAndForegroundRacingKill(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	tabID := "resize-vs-kill"
	spawnTestScript(t, service, tabID, `
echo READY
while :; do sleep 1; done
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	key := mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: tabID})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resize := mustJSON(t, ResizeParams{WorkspaceID: testWorkspaceID, TabID: tabID, Cols: 80 + i, Rows: 24})
			for {
				select {
				case <-stop:
					return
				default:
				}
				_, _ = service.Resize(context.Background(), resize)
				_, _ = service.ForegroundProcess(context.Background(), key)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := service.Kill(context.Background(), key); err != nil {
		t.Fatalf("kill: %v", err)
	}
	recorder.requireExit(t, tabID, 3*time.Second)
	close(stop)
	wg.Wait()
}

func TestForegroundToldAloneOnlyWhenTheShellRunsNothing(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	spawnTestScript(t, service, "waiting", `
echo WAITING
sleep 30
`)
	spawnTestScript(t, service, "reading", `
echo READING
read line
`)
	recorder.requireTranscriptContains(t, "WAITING", 2*time.Second)
	recorder.requireTranscriptContains(t, "READING", 2*time.Second)
	foreground := func(tabID string, alone bool) ForegroundProcessResult {
		raw := mustJSON(t, ForegroundProcessParams{WorkspaceID: testWorkspaceID, TabID: tabID, Alone: alone})
		result, err := service.ForegroundProcess(context.Background(), raw)
		if err != nil {
			t.Fatalf("foregroundProcess %s: %v", tabID, err)
		}
		return result.(ForegroundProcessResult)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := foreground("waiting", true)
		if got.Name == "sh" && got.Alone != nil && !*got.Alone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiting script: name %q alone %v, want sh not alone", got.Name, got.Alone)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := foreground("reading", true); got.Name != "sh" || got.Alone == nil || !*got.Alone {
		t.Fatalf("reading script: name %q alone %v, want sh alone", got.Name, got.Alone)
	}
	if got := foreground("reading", false); got.Alone != nil {
		t.Fatalf("alone reported unasked: %v", *got.Alone)
	}
	for _, tabID := range []string{"waiting", "reading"} {
		if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: tabID})); err != nil {
			t.Fatalf("kill %s: %v", tabID, err)
		}
		recorder.requireExit(t, tabID, 3*time.Second)
	}
}

func TestExitReportedWhileBackgroundJobHoldsTerminal(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		script string
		kill   bool
	}{
		{name: "shell-exits", script: "set -m\nsleep 30 &\necho \"BG=$! READY\"\nexit 0\n"},
		{name: "shell-killed", script: "set -m\nsleep 30 &\necho \"BG=$! READY\"\nsleep 30\n", kill: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, recorder := newTestService(t)
			tabID := "bg-job-" + tc.name
			spawnTestScript(t, service, tabID, tc.script)
			recorder.requireTranscriptContains(t, "READY", 2*time.Second)
			if transcript := recorder.transcript(); strings.Contains(transcript, "BG=") {
				var bgPID int
				if _, err := fmt.Sscanf(transcript[strings.Index(transcript, "BG="):], "BG=%d", &bgPID); err == nil && bgPID > 0 {
					t.Cleanup(func() { _ = syscall.Kill(bgPID, syscall.SIGKILL) })
				}
			}
			if tc.kill {
				if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: tabID})); err != nil {
					t.Fatalf("kill: %v", err)
				}
			}
			recorder.requireExit(t, tabID, 3*time.Second)
		})
	}
}

type eventRecorder struct {
	mu      sync.Mutex
	data    [][]byte
	exits   []ExitPayload
	sinkErr error
}

func newTestService(t *testing.T) (*Service, *eventRecorder) {
	t.Helper()
	recorder := &eventRecorder{}
	service := New()
	service.SetEventSink(context.Background(), recorder.sink)
	t.Cleanup(service.Close)
	return service, recorder
}

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

func (r *eventRecorder) transcript() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(bytes.Join(r.data, nil))
}

func (r *eventRecorder) dataBytes() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dataBytesLocked()
}

func (r *eventRecorder) dataBytesLocked() int {
	total := 0
	for _, chunk := range r.data {
		total += len(chunk)
	}
	return total
}

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

func spawnTestScript(t *testing.T, service *Service, tabID string, body string) SpawnResult {
	t.Helper()
	path := writeTestScript(t, body)
	params := SpawnParams{WorkspaceID: testWorkspaceID, TabID: tabID, Cwd: t.TempDir(), Shell: "/bin/sh", Args: []string{path}, Cols: 80, Rows: 24}
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

func writeTestScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "child.sh")
	content := strings.TrimLeft(body, "\n")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write test script: %v", err)
	}
	return path
}

func writeSession(t *testing.T, service *Service, tabID string, data string) {
	t.Helper()
	_, err := service.Write(context.Background(), mustJSON(t, WriteParams{WorkspaceID: testWorkspaceID, TabID: tabID, Data: data}))
	if err != nil {
		t.Fatalf("write %s: %v", tabID, err)
	}
}

func ackSession(t *testing.T, service *Service, tabID string, bytesConsumed int) {
	t.Helper()
	_, err := service.Ack(context.Background(), mustJSON(t, AckParams{WorkspaceID: testWorkspaceID, TabID: tabID, BytesConsumed: bytesConsumed}))
	if err != nil {
		t.Fatalf("ack %s: %v", tabID, err)
	}
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return data
}

func envValue(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return entry[len(prefix):], true
		}
	}
	return "", false
}

func TestMergeEnvInjectsUTF8LocaleWhenAbsent(t *testing.T) {
	t.Setenv("LANG", "")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "")

	env := mergeEnv(nil)

	got, ok := envValue(env, "LANG")
	if !ok || got != "C.UTF-8" {
		t.Fatalf("LANG fallback missing: got %q (present=%v)", got, ok)
	}
}

func TestMergeEnvPreservesUserLang(t *testing.T) {
	t.Setenv("LANG", "ko_KR.UTF-8")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "")

	env := mergeEnv(nil)

	got, _ := envValue(env, "LANG")
	if got != "ko_KR.UTF-8" {
		t.Fatalf("user LANG was overridden: %q", got)
	}
}

func TestMergeEnvPreservesLcAllWithoutLang(t *testing.T) {
	t.Setenv("LANG", "")
	t.Setenv("LC_ALL", "ja_JP.UTF-8")
	t.Setenv("LC_CTYPE", "")

	env := mergeEnv(nil)

	if got, _ := envValue(env, "LANG"); got == "C.UTF-8" {
		t.Fatalf("LANG fallback applied despite LC_ALL=ja_JP.UTF-8 (got LANG=%q)", got)
	}
	if got, _ := envValue(env, "LC_ALL"); got != "ja_JP.UTF-8" {
		t.Fatalf("LC_ALL not preserved: %q", got)
	}
}

func TestMergeEnvOverrideLangIsRespected(t *testing.T) {
	t.Setenv("LANG", "")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "")

	env := mergeEnv(map[string]string{"LANG": "en_US.UTF-8"})

	got, _ := envValue(env, "LANG")
	if got != "en_US.UTF-8" {
		t.Fatalf("override LANG ignored: %q", got)
	}
}
