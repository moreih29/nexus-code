package agentrun

import (
	"crypto/rand"
	"encoding/binary"
	"time"
)

// NewEpoch generates the agentEpoch token that identifies this daemon boot.
// It combines the current Unix timestamp (seconds) in the high 32 bits with
// 32 bits of cryptographic random so two rapid restarts of the same daemon
// produce distinct epochs even when wall-clock resolution is coarse.
//
// The client compares the epoch on reattach: a match means the same daemon
// is still running (reattach is valid); a mismatch means the daemon was
// replaced and any queued reconnect state must be discarded.
func NewEpoch() uint64 {
	var randBuf [4]byte
	_, _ = rand.Read(randBuf[:]) // crypto/rand; ignore error — falls back to 0 bits on failure
	hi := uint64(time.Now().Unix()) << 32
	lo := uint64(binary.LittleEndian.Uint32(randBuf[:]))
	return hi | lo
}
