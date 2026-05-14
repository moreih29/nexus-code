package lsp

import (
	"fmt"

	"github.com/nexus-code/nexus-code/internal/proto"
)

func requestFailed(format string, args ...any) error {
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf(format, args...)}
}

func protocolError(message string) error {
	return proto.ProtocolError(message)
}
