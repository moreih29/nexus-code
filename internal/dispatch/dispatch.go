// Package dispatch maps NDJSON request method names to handler
// functions. It is intentionally tiny — a name → fn map with success /
// error envelope wrapping — so domain packages (fsops today, git
// tomorrow) own their own method registration and the wire format
// stays the only shared contract between them and the channel.
package dispatch

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// Handler is the contract every registered method must satisfy.
// Returning (nil, nil) is a programming error — the dispatcher will
// surface it as a success response with a null result, which the
// client cannot distinguish from a void-returning method. Domain
// handlers must return either a non-nil result or a non-nil error.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// Dispatcher is a method-name → Handler registry. Lookups are
// read-only after registration completes (during boot), so the map
// does not need synchronization.
type Dispatcher struct {
	handlers map[string]Handler
}

// New constructs an empty Dispatcher ready for Register calls.
func New() *Dispatcher {
	return &Dispatcher{handlers: make(map[string]Handler)}
}

// Register binds `method` to `handler`. The last registration wins —
// duplicate names overwrite silently, which keeps the API simple at
// the cost of catching typo collisions only via tests.
func (d *Dispatcher) Register(method string, handler Handler) {
	d.handlers[method] = handler
}

// Dispatch looks up the request's method and runs it. The two terminal
// shapes are:
//   - unknown method   → proto.Failure with CodeUnsupported
//   - handler error    → proto.ErrorResponse (preserves the error's code)
//   - handler success  → proto.Success carrying the result payload
//
// The context passes through to the handler so it can honor cancellation
// — the host cancels its context during SIGTERM drain.
func (d *Dispatcher) Dispatch(ctx context.Context, req proto.Request) proto.Response {
	handler := d.handlers[req.Method]
	if handler == nil {
		return proto.Failure(req.ID, proto.CodeUnsupported, fmt.Sprintf("method not supported: %s", req.Method))
	}

	result, err := handler(ctx, req.Params)
	if err != nil {
		return proto.ErrorResponse(req.ID, err)
	}
	return proto.Success(req.ID, result)
}
