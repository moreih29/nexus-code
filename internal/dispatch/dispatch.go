package dispatch

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type Handler func(ctx context.Context, params json.RawMessage) (any, error)

type Dispatcher struct {
	handlers map[string]Handler
}

func New() *Dispatcher {
	return &Dispatcher{handlers: make(map[string]Handler)}
}

func (d *Dispatcher) Register(method string, handler Handler) {
	d.handlers[method] = handler
}

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
