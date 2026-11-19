package pty

import (
	"github.com/nexus-code/nexus-code/internal/proto"
)

// requestFailed formats a PTY-domain failure into the standard agent error code.
func requestFailed(format string, args ...any) error {
	return proto.RequestFailed(format, args...)
}

// protocolError marks malformed PTY RPC parameters as envelope-level failures.
func protocolError(message string) error {
	return proto.ProtocolError(message)
}
