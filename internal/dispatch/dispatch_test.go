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
