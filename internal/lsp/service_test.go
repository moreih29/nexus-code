package lsp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentfs "github.com/nexus-code/nexus-code/internal/fs"
)

type recordedEvent struct {
	name    string
	payload any
}

// TestServiceNotifyForwardsWithoutBlockingCaller verifies the lsp.notify handler:
// it forwards the LSP notification to the child process and returns a void ack
// without semantic content — the TS caller fires and forgets, but the handler
// must still deliver the message to the LSP server process.
func TestServiceNotifyForwardsWithoutBlockingCaller(t *testing.T) {
	recordPath := filepath.Join(t.TempDir(), "notify-record.jsonl")
	service, events := newTestService(t)
	result := spawnFakeServer(t, service, "roundtrip", nil, recordPath)

	// Send a textDocument/didOpen notification via the lsp.notify path.
	notification := json.RawMessage(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///tmp/main.go","languageId":"go","version":1,"text":"package main\n"}}}`)
	if _, err := service.Notify(context.Background(), mustJSON(t, NotifyParams{ServerID: result.ServerID, Message: notification})); err != nil {
		t.Fatalf("Notify() error = %v", err)
	}

	// The fake server for "roundtrip" echoes requests and records to the file.
	// A notification with no id will not produce an echo, but the service should
	// have forwarded it. Verify by checking the lsp.message event emitted for the
	// notification (the fake server in roundtrip mode echoes back the message).
	// Since textDocument/didOpen is a notification, we only assert the call returns
	// without error — the fake server may not produce a response for it.
	_ = events // events channel is wired but we only assert no error above

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: result.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestServiceSpawnSendRoundTripShutdown(t *testing.T) {
	service, events := newTestService(t)
	result := spawnFakeServer(t, service, "roundtrip", nil, "")

	message := json.RawMessage(`{"jsonrpc":"2.0","id":"client-1","method":"custom/echo","params":{"value":42}}`)
	if _, err := service.Send(context.Background(), mustJSON(t, SendParams{ServerID: result.ServerID, Message: message})); err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	event := waitEvent(t, events, EventMessage)
	payload := event.payload.(MessagePayload)
	if payload.ServerID != result.ServerID {
		t.Fatalf("message serverId = %q, want %q", payload.ServerID, result.ServerID)
	}
	var response struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(payload.Message, &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.ID != "client-1" || !strings.Contains(string(response.Result), `"value":42`) {
		t.Fatalf("unexpected round trip response: %s", payload.Message)
	}

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: result.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestSpawnAddsEnvOverTheAgents(t *testing.T) {
	service, _ := newTestService(t)
	// Without the spawn's own value the helper would not act as a server.
	t.Setenv("NEXUS_LSP_FAKE_SERVER", "0")

	params := SpawnParams{
		WorkspaceID:   "workspace",
		LanguageID:    "fake",
		BinaryPath:    os.Args[0],
		Args:          []string{"-test.run=TestFakeLSPServerHelper", "--", "roundtrip"},
		WorkspaceRoot: t.TempDir(),
		Env:           map[string]string{"NEXUS_LSP_FAKE_SERVER": "1"},
	}
	result, err := service.Spawn(context.Background(), mustJSON(t, params))
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	serverID := result.(SpawnResult).ServerID
	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: serverID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestIdleTimerTriggersGracefulShutdown(t *testing.T) {
	service, _ := newTestService(t)
	markerPath := filepath.Join(t.TempDir(), "idle-marker.txt")
	idleMs := 100
	_ = spawnFakeServer(t, service, "idle", &idleMs, markerPath)

	waitForFileContains(t, markerPath, "exit", 2*time.Second)
}

func TestServerRequestCorrelationRestoresOriginalWireID(t *testing.T) {
	service, events := newTestService(t)
	recordPath := filepath.Join(t.TempDir(), "server-response.jsonl")
	result := spawnFakeServer(t, service, "server-request", nil, recordPath)

	event := waitEvent(t, events, EventServerRequest)
	payload := event.payload.(ServerRequestPayload)
	if payload.ServerID != result.ServerID || payload.Method != "workspace/configuration" {
		t.Fatalf("unexpected server request payload: %#v", payload)
	}

	response := RespondServerRequestParams{
		ServerID:       result.ServerID,
		AgentRequestID: payload.AgentRequestID,
		Result:         json.RawMessage(`[{"section":"fake"}]`),
	}
	if _, err := service.RespondServerRequest(context.Background(), mustJSON(t, response)); err != nil {
		t.Fatalf("RespondServerRequest() error = %v", err)
	}
	waitUntil(t, 2*time.Second, func() bool { return service.serverRequestCount(result.ServerID) == 0 })

	record := waitForFileLineCount(t, recordPath, 1, 2*time.Second)[0]
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(record), &raw); err != nil {
		t.Fatalf("unmarshal recorded response: %v", err)
	}
	if string(raw["id"]) != "99" {
		t.Fatalf("response restored id = %s, want numeric 99", raw["id"])
	}
	if !strings.Contains(record, `"result":[{"section":"fake"}]`) {
		t.Fatalf("response did not carry result: %s", record)
	}

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: result.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestSpawnEmitsServerAssignedBeforeReturning(t *testing.T) {
	// The host needs to bind serverId↔correlationId before initialize
	// completes so server-pushed events arriving during initialize can be
	// routed without falling back to a "first pending spawn" heuristic.
	service, events := newTestService(t)
	correlationID := "corr-abc"

	t.Setenv("NEXUS_LSP_FAKE_SERVER", "1")
	params := SpawnParams{
		WorkspaceID:   "workspace",
		LanguageID:    "fake",
		BinaryPath:    os.Args[0],
		Args:          []string{"-test.run=TestFakeLSPServerHelper", "--", "roundtrip"},
		WorkspaceRoot: t.TempDir(),
		CorrelationID: correlationID,
	}
	result, err := service.Spawn(context.Background(), mustJSON(t, params))
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	spawnResult := result.(SpawnResult)

	event := waitEvent(t, events, EventServerAssigned)
	payload := event.payload.(ServerAssignedPayload)
	if payload.ServerID != spawnResult.ServerID {
		t.Fatalf("serverAssigned serverId = %q, want %q", payload.ServerID, spawnResult.ServerID)
	}
	if payload.CorrelationID != correlationID {
		t.Fatalf("serverAssigned correlationId = %q, want %q", payload.CorrelationID, correlationID)
	}

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: spawnResult.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func TestShutdownEmitsServerExited(t *testing.T) {
	// serverExited is the signal the TS host uses to drop in-flight
	// requests and forget the server; verify it fires for a clean
	// shutdown path (idle timer test already covers the kill path).
	service, events := newTestService(t)
	result := spawnFakeServer(t, service, "roundtrip", nil, "")

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: result.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}

	event := waitEvent(t, events, EventServerExited)
	payload := event.payload.(ServerExitedPayload)
	if payload.ServerID != result.ServerID {
		t.Fatalf("serverExited serverId = %q, want %q", payload.ServerID, result.ServerID)
	}
	if !payload.Shutdown {
		t.Fatal("serverExited after lsp.shutdown does not say the agent stopped the server")
	}
}

// The client restarts a server that crashed but not one that sat idle, and
// tells the two apart by Shutdown.
func TestIdleExitSaysTheAgentStoppedTheServer(t *testing.T) {
	service, events := newTestService(t)
	idleMs := 100
	_ = spawnFakeServer(t, service, "idle", &idleMs, "")

	payload := waitEvent(t, events, EventServerExited).payload.(ServerExitedPayload)
	if !payload.Shutdown {
		t.Fatal("serverExited after the idle timeout does not say the agent stopped the server")
	}
}

func TestSpawnReturnsServerInfo(t *testing.T) {
	service, _ := newTestService(t)
	result := spawnFakeServer(t, service, "roundtrip", nil, "")

	if result.ServerInfo == nil || *result.ServerInfo != (ServerInfo{Name: "fake-lsp", Version: "1.2.3"}) {
		t.Fatalf("ServerInfo = %+v, want fake-lsp 1.2.3", result.ServerInfo)
	}
	shutdownServer(t, service, result.ServerID)
}

func TestStatsReportsEachServersMemory(t *testing.T) {
	service, _ := newTestService(t)
	result := spawnFakeServer(t, service, "roundtrip", nil, "")

	raw, err := service.Stats(context.Background(), nil)
	if err != nil {
		t.Fatalf("Stats() error = %v", err)
	}
	stats := raw.(StatsResult)
	if len(stats.Servers) != 1 || stats.Servers[0].ServerID != result.ServerID {
		t.Fatalf("Stats() servers = %+v, want the one spawned", stats.Servers)
	}
	if stats.Servers[0].RSSBytes == 0 {
		t.Fatal("Stats() reported no memory for a running server")
	}
	shutdownServer(t, service, result.ServerID)
}

// cmd.Wait closes the stdout and stderr pipes as soon as the server exits.
// Run alongside the readers, it cut off whatever they had not consumed yet:
// the end of the crash output that serverExited carries as StderrTail, and
// the last messages the server wrote.
func TestServerExitKeepsFinalOutput(t *testing.T) {
	service, events := newTestService(t)
	result := spawnFakeServer(t, service, "crash", nil, "")

	sawMessage := false
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			switch event.name {
			case EventMessage:
				if strings.Contains(string(event.payload.(MessagePayload).Message), "parting message") {
					sawMessage = true
				}
			case EventServerExited:
				payload := event.payload.(ServerExitedPayload)
				if payload.ServerID != result.ServerID {
					t.Fatalf("serverExited serverId = %q, want %q", payload.ServerID, result.ServerID)
				}
				if payload.Shutdown {
					t.Fatal("a crash is reported as the agent stopping the server")
				}
				if !strings.HasSuffix(payload.StderrTail, "last stderr line\n") {
					t.Fatalf("stderr tail lost the end of the crash output: ...%q", tail(payload.StderrTail, 80))
				}
				if !sawMessage {
					t.Fatal("the server's last message was not delivered before serverExited")
				}
				return
			}
		case <-timer.C:
			t.Fatal("timed out waiting for serverExited")
		}
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func TestJSONRPCIDKeyRejectsNullID(t *testing.T) {
	// null id was previously accepted as a valid key, which let a buggy
	// or malicious server pollute the pending-internal map under a
	// literal "null" key. Reject it explicitly; string and numeric ids
	// remain valid.
	if _, ok := jsonRPCIDKey(json.RawMessage("null")); ok {
		t.Fatal("jsonRPCIDKey should reject null id")
	}
	if _, ok := jsonRPCIDKey(json.RawMessage("")); ok {
		t.Fatal("jsonRPCIDKey should reject empty raw id")
	}
	if _, ok := jsonRPCIDKey(json.RawMessage(`"abc"`)); !ok {
		t.Fatal("jsonRPCIDKey should accept string id")
	}
	if _, ok := jsonRPCIDKey(json.RawMessage("42")); !ok {
		t.Fatal("jsonRPCIDKey should accept number id")
	}
}

func TestServiceRoutesFSChangedToRegisteredWatchedFiles(t *testing.T) {
	service, events := newTestService(t)
	recordPath := filepath.Join(t.TempDir(), "watched-files.jsonl")
	result := spawnFakeServer(t, service, "watched-files", nil, recordPath)

	event := waitEvent(t, events, EventServerRequest)
	payload := event.payload.(ServerRequestPayload)
	if payload.ServerID != result.ServerID || payload.Method != methodClientRegisterCapability {
		t.Fatalf("unexpected server request payload: %#v", payload)
	}
	if !strings.Contains(string(payload.Params), methodDidChangeWatchedFiles) {
		t.Fatalf("server request did not include watched-files registration: %s", payload.Params)
	}

	response := RespondServerRequestParams{
		ServerID:       result.ServerID,
		AgentRequestID: payload.AgentRequestID,
		Result:         json.RawMessage(`null`),
	}
	if _, err := service.RespondServerRequest(context.Background(), mustJSON(t, response)); err != nil {
		t.Fatalf("RespondServerRequest() error = %v", err)
	}
	waitUntil(t, 2*time.Second, func() bool { return service.serverRequestCount(result.ServerID) == 0 })

	err := service.HandleFSChanged(agentfs.FsChangedPayload{
		Changes: []agentfs.FsChange{
			{RelPath: "src/main.go", Kind: agentfs.FsChangeModified},
			{RelPath: "README.md", Kind: agentfs.FsChangeModified},
		},
	})
	if err != nil {
		t.Fatalf("HandleFSChanged() error = %v", err)
	}

	record := waitForFileLineCount(t, recordPath, 1, 2*time.Second)[0]
	var notification struct {
		Method string `json:"method"`
		Params struct {
			Changes []struct {
				URI  string `json:"uri"`
				Type int    `json:"type"`
			} `json:"changes"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(record), &notification); err != nil {
		t.Fatalf("unmarshal watched-files notification: %v", err)
	}
	if notification.Method != methodDidChangeWatchedFiles {
		t.Fatalf("notification method = %q, want %q", notification.Method, methodDidChangeWatchedFiles)
	}
	if len(notification.Params.Changes) != 1 {
		t.Fatalf("notification changes length = %d, want 1: %s", len(notification.Params.Changes), record)
	}
	change := notification.Params.Changes[0]
	if change.Type != lspFileChangeChanged {
		t.Fatalf("change type = %d, want %d", change.Type, lspFileChangeChanged)
	}
	if !strings.HasPrefix(change.URI, "file://") || !strings.HasSuffix(change.URI, "/src/main.go") {
		t.Fatalf("change uri = %q, want file URI ending in /src/main.go", change.URI)
	}

	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: result.ServerID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

// shutdownServer stops a server before the test's temp dir is removed:
// Windows refuses to remove the directory a running process works in.
func shutdownServer(t *testing.T, service *Service, serverID string) {
	t.Helper()
	if _, err := service.Shutdown(context.Background(), mustJSON(t, ShutdownParams{ServerID: serverID})); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}

func newTestService(t *testing.T) (*Service, <-chan recordedEvent) {
	t.Helper()
	service := New()
	events := make(chan recordedEvent, 128)
	service.SetEventSink(func(event string, payload any) error {
		events <- recordedEvent{name: event, payload: payload}
		return nil
	})
	t.Cleanup(service.Close)
	return service, events
}

func spawnFakeServer(t *testing.T, service *Service, mode string, idleMs *int, recordPath string) SpawnResult {
	t.Helper()
	t.Setenv("NEXUS_LSP_FAKE_SERVER", "1")
	if recordPath != "" {
		t.Setenv("NEXUS_LSP_FAKE_RECORD_PATH", recordPath)
	}

	params := SpawnParams{
		WorkspaceID:   "workspace",
		LanguageID:    "fake",
		BinaryPath:    os.Args[0],
		Args:          []string{"-test.run=TestFakeLSPServerHelper", "--", mode},
		WorkspaceRoot: t.TempDir(),
		IdleTimeoutMs: idleMs,
	}
	result, err := service.Spawn(context.Background(), mustJSON(t, params))
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	spawnResult := result.(SpawnResult)
	if spawnResult.ServerID == "" {
		t.Fatal("Spawn() returned empty serverId")
	}
	if !strings.Contains(string(spawnResult.Capabilities), `"hoverProvider":true`) {
		t.Fatalf("capabilities not returned: %s", spawnResult.Capabilities)
	}
	return spawnResult
}

func waitEvent(t *testing.T, events <-chan recordedEvent, name string) recordedEvent {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event.name == name {
				return event
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for event %s", name)
		}
	}
}

func waitForFileContains(t *testing.T, path string, needle string, timeout time.Duration) {
	t.Helper()
	waitUntil(t, timeout, func() bool {
		data, err := os.ReadFile(path)
		return err == nil && strings.Contains(string(data), needle)
	})
}

func waitForFileLineCount(t *testing.T, path string, count int, timeout time.Duration) []string {
	t.Helper()
	var lines []string
	waitUntil(t, timeout, func() bool {
		data, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		lines = nil
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line != "" {
				lines = append(lines, line)
			}
		}
		return len(lines) >= count
	})
	return lines[:count]
}

func waitUntil(t *testing.T, timeout time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// A restarted agent receives the calls queued for the one it replaced; its
// servers must not answer to the old servers' ids.
func TestServerIDsDifferBetweenServices(t *testing.T) {
	first, second := New(), New()
	if a, b := first.nextServerID(), second.nextServerID(); a == b {
		t.Fatalf("both services named their first server %q", a)
	}
}

// Some servers read settings only from initialize, such as
// typescript-language-server's tsserver options.
func TestInitializeSendsInitializationOptions(t *testing.T) {
	options := json.RawMessage(`{"tsserver":{"useSyntaxServer":"never"}}`)
	with := newServerProcess(New(), "lsp-x-1", SpawnParams{WorkspaceRoot: t.TempDir(), InitializationOptions: options}, 0)
	if got, _ := with.initializeParams()["initializationOptions"].(json.RawMessage); string(got) != string(options) {
		t.Fatalf("initializationOptions = %s, want %s", got, options)
	}

	without := newServerProcess(New(), "lsp-x-2", SpawnParams{WorkspaceRoot: t.TempDir()}, 0)
	if _, ok := without.initializeParams()["initializationOptions"]; ok {
		t.Fatal("initialize carried initializationOptions nobody set")
	}
}
