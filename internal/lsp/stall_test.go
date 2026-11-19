package lsp

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// blockedInput models a pipe whose child stopped reading.
type blockedInput struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
	start   sync.Once
}

// Write blocks until the input is force-closed.
func (p *blockedInput) Write([]byte) (int, error) {
	p.start.Do(func() { close(p.started) })
	<-p.closed
	return 0, io.ErrClosedPipe
}

// Close releases the blocked writer.
func (p *blockedInput) Close() error {
	p.once.Do(func() { close(p.closed) })
	return nil
}

// TestShutdownClosesBlockedInput verifies that a canceled shutdown can tear
// down a server even when an earlier LSP frame still owns its stdin writer.
func TestShutdownClosesBlockedInput(t *testing.T) {
	svc := New()
	server := newServerProcess(svc, "stalled", SpawnParams{}, 0)
	input := &blockedInput{started: make(chan struct{}), closed: make(chan struct{})}
	server.stdin = input
	t.Cleanup(func() { _ = input.Close() })
	svc.servers[server.id] = server
	go func() {
		<-input.closed
		server.markExited(nil)
	}()

	notify := make(chan error, 1)
	go func() {
		_, err := svc.Notify(context.Background(), json.RawMessage(`{"serverId":"stalled","message":{"jsonrpc":"2.0","method":"textDocument/didChange"}}`))
		notify <- err
	}()
	<-input.started

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	shutdown := make(chan error, 1)
	go func() { shutdown <- server.Shutdown(ctx) }()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-shutdown:
	case <-timer.C:
		t.Fatal("shutdown waited on the blocked stdin writer")
	}
	select {
	case err := <-notify:
		if err == nil {
			t.Fatal("blocked write succeeded after shutdown")
		}
	case <-timer.C:
		t.Fatal("shutdown left the write blocked")
	}
}
