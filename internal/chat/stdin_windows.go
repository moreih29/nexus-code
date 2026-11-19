//go:build windows

package chat

import (
	"context"
	"errors"
	"io"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// overlappedStdin owns the write end. The child's synchronous handle reads
// the same byte stream without needing to know about cancellation.
type overlappedStdin struct {
	mu     sync.Mutex
	handle windows.Handle
	closed context.Context
	cancel context.CancelFunc
}

// newChatStdin opens an overlapped write end because anonymous Windows pipes
// do not support write deadlines in Go.
func newChatStdin(generation string) (stdinWriter, *os.File, error) {
	name, err := windows.UTF16PtrFromString(`\\.\pipe\nexus-chat-` + generation)
	if err != nil {
		return nil, nil, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return nil, nil, err
	}
	security := windows.SecurityAttributes{SecurityDescriptor: sd}
	security.Length = uint32(unsafe.Sizeof(security))
	handle, err := windows.CreateNamedPipe(name,
		windows.PIPE_ACCESS_OUTBOUND|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_MESSAGE|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 64<<10, 0, 0, &security)
	if err != nil {
		return nil, nil, err
	}
	child, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		_ = windows.CloseHandle(handle)
		return nil, nil, err
	}
	// CreateFile already connected the client; its default read mode is byte.
	closed, cancel := context.WithCancel(context.Background())
	return &overlappedStdin{handle: handle, closed: closed, cancel: cancel}, os.NewFile(uintptr(child), "chat stdin"), nil
}

// Close cancels and joins an active write before releasing its handle.
func (w *overlappedStdin) Close() error {
	w.cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(w.handle)
	w.handle = 0
	return err
}

func (w *overlappedStdin) WriteContext(request context.Context, data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed.Err() != nil {
		return 0, io.ErrClosedPipe
	}
	ctx, cancel := context.WithCancel(request)
	defer cancel()
	stopClosing := context.AfterFunc(w.closed, cancel)
	defer stopClosing()

	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(event)
	// A message fits inside the pipe's quota. Counting completed messages
	// preserves the distinction between an untouched and a partial frame.
	written := 0
	for len(data) != 0 {
		chunk := data[:min(len(data), 16<<10)]
		n, err := w.writeChunk(ctx, event, chunk)
		written += n
		if err != nil {
			return written, err
		}
		if n != len(chunk) {
			return written, io.ErrShortWrite
		}
		data = data[n:]
	}
	return written, nil
}

// writeChunk cancels the specific operation and waits for kernel completion
// before its buffer and OVERLAPPED structure can be reused.
func (w *overlappedStdin) writeChunk(ctx context.Context, event windows.Handle, data []byte) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	op := &windows.Overlapped{HEvent: event}
	var n uint32
	err := windows.WriteFile(w.handle, data, &n, op)
	if err != nil && !errors.Is(err, windows.ERROR_IO_PENDING) {
		return int(n), err
	}
	if err == nil {
		err = windows.GetOverlappedResult(w.handle, op, &n, false)
	} else {
		finished := make(chan struct{})
		stop := context.AfterFunc(ctx, func() {
			_ = windows.CancelIoEx(w.handle, op)
			close(finished)
		})
		err = windows.GetOverlappedResult(w.handle, op, &n, true)
		if !stop() {
			<-finished
		}
	}
	runtime.KeepAlive(data)
	if errors.Is(err, windows.ERROR_OPERATION_ABORTED) && ctx.Err() != nil {
		err = ctx.Err()
	}
	return int(n), err
}
