package lsp

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"testing"
)

type bufferWriteCloser struct {
	*bytes.Buffer
}

func (w bufferWriteCloser) Close() error {
	return nil
}

func TestServerRequestCorrelationCleansThousandRequests(t *testing.T) {
	service := New()
	events := make(chan recordedEvent, 1000)
	service.SetEventSink(func(event string, payload any) error {
		events <- recordedEvent{name: event, payload: payload}
		return nil
	})

	var writes bytes.Buffer
	server := newServerProcess(service, "lsp-test", SpawnParams{}, 0)
	server.stdin = bufferWriteCloser{Buffer: &writes}
	service.storeServer(server)

	const requestCount = 1000
	for i := 0; i < requestCount; i++ {
		server.handleServerRequest(json.RawMessage(strconv.Itoa(i)), "workspace/configuration", json.RawMessage(`{"items":[]}`))
	}
	if got := service.serverRequestCount(server.id); got != requestCount {
		t.Fatalf("pending server requests = %d, want %d", got, requestCount)
	}

	seen := make(map[int]struct{}, requestCount)
	for i := 0; i < requestCount; i++ {
		event := <-events
		if event.name != EventServerRequest {
			t.Fatalf("event %d name = %q, want %q", i, event.name, EventServerRequest)
		}
		payload := event.payload.(ServerRequestPayload)
		response := RespondServerRequestParams{
			ServerID:       server.id,
			AgentRequestID: payload.AgentRequestID,
			Result:         json.RawMessage(`{"ok":true}`),
		}
		if _, err := service.RespondServerRequest(context.Background(), mustJSON(t, response)); err != nil {
			t.Fatalf("RespondServerRequest(%q) error = %v", payload.AgentRequestID, err)
		}
		seen[i] = struct{}{}
	}
	if got := service.serverRequestCount(server.id); got != 0 {
		t.Fatalf("pending server requests after responses = %d, want 0", got)
	}
	if len(seen) != requestCount {
		t.Fatalf("responded to %d requests, want %d", len(seen), requestCount)
	}

	messages, err := NewDecoder().Append(writes.Bytes())
	if err != nil {
		t.Fatalf("decode response frames: %v", err)
	}
	if len(messages) != requestCount {
		t.Fatalf("encoded responses = %d, want %d", len(messages), requestCount)
	}
	for i, message := range messages {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(message, &raw); err != nil {
			t.Fatalf("unmarshal response %d: %v", i, err)
		}
		if string(raw["id"]) != strconv.Itoa(i) {
			t.Fatalf("response %d id = %s, want %d", i, raw["id"], i)
		}
	}
}
