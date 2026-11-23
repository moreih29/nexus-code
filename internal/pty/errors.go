package pty

import (
	"github.com/nexus-code/nexus-code/internal/proto"
)

func requestFailed(format string, args ...any) error {
	return proto.RequestFailed(format, args...)
}

func protocolError(message string) error {
	return proto.ProtocolError(message)
}
