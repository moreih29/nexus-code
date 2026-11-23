package pty

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestReplayCreditAcrossDialers(t *testing.T) {
	for _, tc := range []struct {
		name        string
		cancelFirst bool
	}{{"disconnect before replacement", true}, {"replace before cancellation", false}} {
		t.Run(tc.name, func(t *testing.T) {
			svc := New()
			ctxA, cancelA := context.WithCancel(context.Background())
			defer cancelA()
			ctxB, cancelB := context.WithCancel(context.Background())
			defer cancelB()
			key := tabKey{workspaceID: "ws", tabID: "tab"}
			sess := newSession(svc, key, nil, nil)
			svc.storeSession(key, sess)
			history := bytes.Repeat([]byte("a"), HighWatermarkBytes+2*MaxChunkSize)
			sess.ringAppend(history)
			t.Cleanup(func() {
				svc.mu.Lock()
				sess.stopped = true
				sess.flowCond.Broadcast()
				svc.mu.Unlock()
			})

			var gotA, gotB replayCapture
			gotA.high = make(chan struct{})
			gotB.high = make(chan struct{})
			svc.SetEventSink(ctxA, gotA.emit)
			params := json.RawMessage(`{"workspaceId":"ws","tabId":"tab"}`)
			ack := json.RawMessage(`{"workspaceId":"ws","tabId":"tab","bytesConsumed":200000}`)
			startReplay := func(ctx context.Context) <-chan error {
				done := make(chan error, 1)
				go func() {
					_, err := svc.Replay(ctx, params)
					done <- err
				}()
				return done
			}
			oldReplay := startReplay(ctxA)
			awaitReplayStep(t, gotA.high)
			attachB := func() {
				svc.SetEventSink(ctxB, gotB.emit)
			}
			if tc.cancelFirst {
				cancelA()
			} else {
				attachB()
			}
			if err := awaitReplayStep(t, oldReplay); !errors.Is(err, context.Canceled) {
				t.Fatalf("old replay returned %v, want context cancellation", err)
			}
			if tc.cancelFirst {
				attachB()
			}

			newReplay := startReplay(ctxB)
			awaitReplayStep(t, gotB.high)
			_, _ = svc.Ack(ctxA, ack)
			svc.mu.Lock()
			paused, debt := sess.paused, sess.outstanding
			svc.mu.Unlock()
			if !paused || debt < HighWatermarkBytes {
				t.Fatalf("old ACK changed new dialer's window: paused=%t debt=%d", paused, debt)
			}

			liveDone := make(chan struct{})
			go func() {
				sess.deliver([]byte("live"))
				close(liveDone)
			}()
			_, _ = svc.Ack(ctxB, ack)
			if err := awaitReplayStep(t, newReplay); err != nil {
				t.Fatalf("new replay failed: %v", err)
			}
			awaitReplayStep(t, liveDone)
			gotB.mu.Lock()
			defer gotB.mu.Unlock()
			want := terminalReset + string(history)
			if gotB.replay.String() != want || gotB.live.String() != "live" || gotB.replayAfterLive {
				t.Fatalf("new dialer output: replay bytes=%d want=%d, live=%q, replay after live=%t", gotB.replay.Len(), len(want), gotB.live.String(), gotB.replayAfterLive)
			}
		})
	}
}

type replayCapture struct {
	mu              sync.Mutex
	replay          bytes.Buffer
	live            bytes.Buffer
	replayAfterLive bool
	high            chan struct{}
}

func (c *replayCapture) emit(_ string, payload any) error {
	data := payload.(DataPayload)
	chunk, err := base64.StdEncoding.DecodeString(data.Chunk)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if data.Replay {
		c.replayAfterLive = c.replayAfterLive || c.live.Len() > 0
		wasBelow := c.replay.Len() < HighWatermarkBytes
		c.replay.Write(chunk)
		if wasBelow && c.replay.Len() >= HighWatermarkBytes {
			close(c.high)
		}
	} else {
		c.live.Write(chunk)
	}
	return nil
}

func awaitReplayStep[T any](t *testing.T, step <-chan T) T {
	t.Helper()
	select {
	case value := <-step:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for replay or output")
		var zero T
		return zero
	}
}
