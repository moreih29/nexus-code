package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestDispatchSuccessAndUnsupportedMethod(t *testing.T) {
	d := New()
	d.Register("ok", func(ctx context.Context, params json.RawMessage) (any, error) {
		return map[string]string{"value": string(params)}, nil
	})

	res := d.Dispatch(context.Background(), proto.Request{ID: "1", Method: "ok", Params: json.RawMessage(`{"relPath":"."}`)})
	if res.Error != nil || res.ID != "1" {
		t.Fatalf("unexpected response: %#v", res)
	}
	if got := res.Result.(map[string]string)["value"]; got != `{"relPath":"."}` {
		t.Fatalf("params not passed through: %q", got)
	}

	res = d.Dispatch(context.Background(), proto.Request{ID: "2", Method: "missing"})
	if res.Error == nil || res.Error.Code != proto.CodeUnsupported || res.Error.Message != "method not supported: missing" {
		t.Fatalf("unsupported response mismatch: %#v", res)
	}
}

func TestDispatchMapsHandlerErrors(t *testing.T) {
	d := New()
	d.Register("bad", func(ctx context.Context, params json.RawMessage) (any, error) {
		return nil, errors.New("boom")
	})
	res := d.Dispatch(context.Background(), proto.Request{ID: "1", Method: "bad"})
	if res.Error == nil || res.Error.Code != proto.CodeRequestFailed || res.Error.Message != "boom" {
		t.Fatalf("error response mismatch: %#v", res)
	}
}

func TestRegisterOrderedMarksOnlyThatMethod(t *testing.T) {
	d := New()
	handler := func(ctx context.Context, params json.RawMessage) (any, error) { return "ok", nil }
	d.RegisterOrdered("ordered", handler)
	d.Register("plain", handler)
	if !d.Ordered("ordered") || d.Ordered("plain") || d.Ordered("missing") {
		t.Fatalf("ordered = %v, plain = %v, missing = %v", d.Ordered("ordered"), d.Ordered("plain"), d.Ordered("missing"))
	}
	if res := d.Dispatch(context.Background(), proto.Request{ID: "1", Method: "ordered"}); res.Result != "ok" {
		t.Fatalf("ordered method not dispatched: %#v", res)
	}
	// A later plain registration replaces the ordered one entirely.
	d.Register("ordered", handler)
	if d.Ordered("ordered") {
		t.Fatal("re-registering with Register kept the method ordered")
	}
}
