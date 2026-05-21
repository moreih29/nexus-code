package hookserver

import (
	"context"
	"encoding/json"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// respondHookParams 는 claude.respondHook dispatch 메서드의 요청 파라미터다.
type respondHookParams struct {
	HookID   string       `json:"hookId"`
	Response HookResponse `json:"response"`
}

// Register 는 claude.respondHook 메서드를 dispatcher에 등록한다.
//
// main→agent 방향의 inbound 메서드로, main이 hook 결정(allow/deny/stdout)을
// 완료했을 때 agent를 통해 대기 중인 hook 클라이언트에게 응답을 전달한다.
func Register(d *dispatch.Dispatcher, srv *Server) {
	d.Register("claude.respondHook", srv.respondHook)
}

// respondHook 은 claude.respondHook dispatch 핸들러다.
// hookId로 in-flight 연결을 찾아 응답을 write하고 연결을 닫는다.
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
