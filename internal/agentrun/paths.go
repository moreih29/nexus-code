package agentrun

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

type Paths struct {
	Sock     string
	Lock     string
	Log      string
	AuthSock string
}

func WsID(rootPath, version string) string {
	h := sha256.Sum256([]byte(version + "\x00" + rootPath))
	return hex.EncodeToString(h[:])[:16]
}

func For(rootPath, version string) (Paths, error) {
	runDir, err := agentpaths.RunDir()
	if err != nil {
		return Paths{}, fmt.Errorf("agentrun: %w", err)
	}
	id := WsID(rootPath, version)
	socketDir := runSocketDir(runDir, id+".agent")
	return Paths{
		Sock:     filepath.Join(socketDir, id+".sock"),
		Lock:     filepath.Join(runDir, id+".lock"),
		Log:      filepath.Join(runDir, id+".log"),
		AuthSock: filepath.Join(socketDir, id+".agent"),
	}, nil
}

func (p Paths) EnsureSocketDir() error {
	dir := filepath.Dir(p.Sock)
	if dir == filepath.Dir(p.Lock) {
		return agentpaths.EnsureDir(dir)
	}
	return ensurePrivateSocketDir(dir)
}
