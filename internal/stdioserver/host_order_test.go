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

func TestOrderedRequestsStayWithTheirServer(t *testing.T) {
	type params struct {
		ServerID string `json:"serverId"`
		Step     string `json:"step"`
	}
	started, release := make(chan struct{}), make(chan struct{})
	steps := make(chan string, 4)
	d := dispatch.New()
	for _, method := range []string{"lsp.notify", "lsp.send", "lsp.cancel"} {
		d.RegisterOrderedBy(method, func(_ context.Context, raw json.RawMessage) (any, error) {
			var p params
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, err
			}
			if p.Step == "stall" {
				close(started)
				<-release
			} else {
				steps <- p.Step
			}
			return struct{}{}, nil
		}, func(raw json.RawMessage) string {
			var p params
			_ = json.Unmarshal(raw, &p)
			return p.ServerID
		})
	}
	in, feed := io.Pipe()
	defer feed.Close()
	host := New(d, in, io.Discard, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ended := make(chan struct{})
	host.exit = func(int) { close(ended) }
	go host.Run()
	releaseStall := sync.OnceFunc(func() { close(release) })
	defer releaseStall()
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	write := func(method, server, step string) {
		t.Helper()
		if _, err := fmt.Fprintf(feed, `{"method":%q,"id":%q,"params":{"serverId":%q,"step":%q}}`+"\n", method, step, server, step); err != nil {
			t.Fatal(err)
		}
	}
	write("lsp.notify", "stalled", "stall")
	select {
	case <-started:
	case <-timeout.C:
		t.Fatal("first request did not start")
	}
	write("lsp.send", "stalled", "obsolete")
	write("lsp.notify", "healthy", "change")
	write("lsp.send", "healthy", "request")
	write("lsp.cancel", "healthy", "cancel")
	for _, want := range []string{"change", "request", "cancel"} {
		select {
		case got := <-steps:
			if got != want {
				t.Fatalf("request %q ran before %q", got, want)
			}
		case <-timeout.C:
			t.Fatalf("healthy server never handled %q", want)
		}
	}
	host.cancel()
	releaseStall()
	_ = feed.Close()
	select {
	case <-ended:
	case <-timeout.C:
		t.Fatal("canceled host did not end")
	}
	select {
	case got := <-steps:
		t.Fatalf("canceled request ran: %q", got)
	default:
	}
}
