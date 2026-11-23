package agentrun

import (
	"crypto/rand"
	"encoding/binary"
	"time"
)

func NewEpoch() uint64 {
	var randBuf [4]byte
	_, _ = rand.Read(randBuf[:])
	hi := uint64(time.Now().Unix()) << 32
	lo := uint64(binary.LittleEndian.Uint32(randBuf[:]))
	return hi | lo
}
