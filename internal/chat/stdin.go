package chat

import (
	"context"
	"io"
)

type stdinWriter interface {
	io.Closer
	WriteContext(context.Context, []byte) (int, error)
}
