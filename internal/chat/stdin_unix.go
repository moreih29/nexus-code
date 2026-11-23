//go:build darwin || linux

package chat

import (
	"context"
	"errors"
	"os"
	"time"
)

type deadlineStdin struct{ *os.File }

func newChatStdin(_ string) (stdinWriter, *os.File, error) {
	child, parent, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	if err := parent.SetWriteDeadline(time.Time{}); err != nil {
		_ = parent.Close()
		_ = child.Close()
		return nil, nil, err
	}
	return deadlineStdin{parent}, child, nil
}

func (w deadlineStdin) WriteContext(ctx context.Context, data []byte) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	finished := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = w.SetWriteDeadline(time.Now())
		close(finished)
	})
	n, err := w.Write(data)
	if !stop() {
		<-finished
		_ = w.SetWriteDeadline(time.Time{})
		if errors.Is(err, os.ErrDeadlineExceeded) {
			err = ctx.Err()
		}
	}
	return n, err
}
