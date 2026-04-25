package wsx

import "context"

const (
	StatusNormalClosure   = 1000
	StatusGoingAway       = 1001
	StatusInternalError   = 1011
	StatusAbnormalClosure = 1006
)

type Server interface {
	Serve(ctx context.Context) error
	Send(ctx context.Context, msg any) error
	Close(code int, reason string) error
}

type Handler interface {
	OnMessage(ctx context.Context, raw []byte) error
	OnClose(code int, reason string)
}
