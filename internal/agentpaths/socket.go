package agentpaths

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
)

var ErrNotPrivate = errors.New("must be a private directory owned by the current user")

func MaxSocketPathLen() int { return sunPathSize - 1 }

func SocketPathFits(path string) bool { return len(path) < sunPathSize }

type SocketPathError struct {
	Path     string
	Fallback string
}

func (e *SocketPathError) Error() string {
	if e.Fallback == "" {
		return fmt.Sprintf("socket path %s is %d bytes, over the %d-byte limit",
			e.Path, len(e.Path), MaxSocketPathLen())
	}
	return fmt.Sprintf("socket path %s is %d bytes and its fallback %s is %d bytes, both over the %d-byte limit",
		e.Path, len(e.Path), e.Fallback, len(e.Fallback), MaxSocketPathLen())
}

func SocketDir(preferred, longestName string) (dir string, fallback bool, err error) {
	wanted := filepath.Join(preferred, longestName)
	if SocketPathFits(wanted) {
		return preferred, false, nil
	}
	short, err := shortSocketDir(preferred)
	if err != nil {
		return "", false, err
	}
	if filepath.Clean(short) == filepath.Clean(preferred) {
		return "", false, &SocketPathError{Path: wanted}
	}
	if candidate := filepath.Join(short, longestName); !SocketPathFits(candidate) {
		return "", false, &SocketPathError{Path: wanted, Fallback: candidate}
	}
	return short, true, nil
}

func preferredHash(preferred string) string {
	sum := sha256.Sum256([]byte(preferred))
	return hex.EncodeToString(sum[:8])
}

func notPrivateDir(dir string) error {
	return fmt.Errorf("agentpaths: socket directory %q %w", dir, ErrNotPrivate)
}

func cannotCheck(dir string, err error) error {
	return fmt.Errorf("agentpaths: cannot check socket directory %q: %w", dir, err)
}
