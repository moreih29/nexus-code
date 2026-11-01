// Package stdioserver — ordered-method tests.
//
// Requests run concurrently, except those of methods registered with
// RegisterOrdered: an LSP server must see its messages in the order the
// client sent them, or a completion request can overtake the didChange
// before it.
package stdioserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// Ordered requests run in arrival order even when an earlier one is the
// slowest, and requests of other methods do not wait behind them.
func TestRunKeepsOrderedMethodsInArrivalOrder(t *testing.T) {
	const count = 50
	var mu sync.Mutex
	var order []int
	release := make(chan struct{})
	d := dispatch.New()
	d.RegisterOrdered("lsp.send", func(_ context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if p.N == 0 {
			<-release
		}
		mu.Lock()
		order = append(order, p.N)
		mu.Unlock()
		return struct{}{}, nil
	})
	// Only an unordered request can open the gate the first ordered one
	// waits at; queued behind it, this one would never run.
	d.Register("ping", func(context.Context, json.RawMessage) (any, error) {
		close(release)
		return "pong", nil
	})

	in, feed := io.Pipe()
	host := New(d, in, io.Discard, slog.New(slog.NewTextHandler(io.Discard, nil)))
	host.exit = func(int) {}
	go host.Run()
	defer feed.Close()

	for n := range count {
		fmt.Fprintf(feed, `{"id":"s%d","method":"lsp.send","params":{"n":%d}}`+"\n", n, n)
	}
	fmt.Fprintln(feed, `{"id":"p","method":"ping"}`)

	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		got := slices.Clone(order)
		mu.Unlock()
		if len(got) == count {
			for i, n := range got {
				if n != i {
					t.Fatalf("ordered requests ran as %v", got)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d ordered requests ran: %v", len(got), count, got)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestMethodAtStart(t *testing.T) {
	cases := map[string]string{
		`{"id":"r-1","method":"lsp.notify","params":{"serverId":"lsp-1"}}`: "lsp.notify",
		` { "id" : "r-\"2" , "method" : "lsp.send" }`:                      "lsp.send",
		// The method must follow the id: one inside params is not it.
		`{"params":{"id":"x","method":"lsp.send"},"id":"r-3","method":"fs.readFile"}`: "",
		`{"method":"lsp.send","id":"r-4"}`:                                            "",
		`not json`:                                                                    "",
	}
	for line, want := range cases {
		if got := methodAtStart([]byte(line)); got != want {
			t.Errorf("methodAtStart(%s) = %q, want %q", line, got, want)
		}
	}
}
