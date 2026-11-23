package hookserver

import (
	"context"
	"encoding/json"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type respondHookParams struct {
	HookID   string       `json:"hookId"`
	Response HookResponse `json:"response"`
}

func Register(d *dispatch.Dispatcher, srv *Server) {
	d.Register("claude.respondHook", srv.respondHook)
	d.Register("cli.respond", srv.respondCLI)
}

func (s *Server) respondHook(_ context.Context, raw json.RawMessage) (any, error) {
	var p respondHookParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("claude.respondHook params must include hookId and response")
	}
	if p.HookID == "" {
		return nil, proto.ProtocolError("claude.respondHook hookId is required")
	}
	if err := s.Respond(p.HookID, p.Response); err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}
	return struct{}{}, nil
}

type respondCLIParams struct {
	RequestID string          `json:"requestId"`
	Response  json.RawMessage `json:"response"`
}

func (s *Server) respondCLI(_ context.Context, raw json.RawMessage) (any, error) {
	var p respondCLIParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || p.RequestID == "" || len(p.Response) == 0 {
		return nil, proto.ProtocolError("cli.respond params must include requestId and response")
	}
	if err := s.RespondCLI(p.RequestID, p.Response); err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}
	return struct{}{}, nil
}
