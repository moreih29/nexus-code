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
	ordered  map[string]func(json.RawMessage) string
}

func New() *Dispatcher {
	return &Dispatcher{handlers: make(map[string]Handler), ordered: make(map[string]func(json.RawMessage) string)}
}

func (d *Dispatcher) Register(method string, handler Handler) {
	d.handlers[method] = handler
	delete(d.ordered, method)
}

func (d *Dispatcher) RegisterOrdered(method string, handler Handler) {
	d.RegisterOrderedBy(method, handler, nil)
}

func (d *Dispatcher) RegisterOrderedBy(method string, handler Handler, key func(json.RawMessage) string) {
	d.handlers[method] = handler
	d.ordered[method] = key
}

func (d *Dispatcher) Ordered(method string) bool {
	_, ok := d.ordered[method]
	return ok
}

func (d *Dispatcher) OrderKey(req proto.Request) (string, bool) {
	key, ordered := d.ordered[req.Method]
	if key == nil {
		return "", ordered
	}
	return key(req.Params), true
}

func (d *Dispatcher) Methods() []string {
	names := make([]string, 0, len(d.handlers))
	for name := range d.handlers {
		names = append(names, name)
	}
	sortStrings(names)
	return names
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		key := s[i]
		j := i - 1
		for j >= 0 && s[j] > key {
			s[j+1] = s[j]
			j--
		}
		s[j+1] = key
	}
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
