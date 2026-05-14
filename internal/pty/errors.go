package pty

import (
	"fmt"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// requestFailed formats a PTY-domain failure into the standard agent error code.
func requestFailed(format string, args ...any) error {
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: fmt.Sprintf(format, args...)}
}

// protocolError marks malformed PTY RPC parameters as envelope-level failures.
func protocolError(message string) error {
	return proto.ProtocolError(message)
}
