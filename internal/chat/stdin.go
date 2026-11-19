package chat

import (
	"context"
	"io"
)

// stdinWriter stops an uncompleted frame when its request is cancelled.
type stdinWriter interface {
	io.Closer
	WriteContext(context.Context, []byte) (int, error)
}
