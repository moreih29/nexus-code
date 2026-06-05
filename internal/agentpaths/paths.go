// Package agentpaths provides Go·TS dual helper functions that resolve the
// ~/.nexus-code runtime directory tree used by the nexus-code agent process.
//
// Both this package and src/main/infra/agent/runtimeDirs.ts are authoritative
// over the same directory layout so that, on the same system with the same HOME,
// both modules produce identical absolute paths. Callers must not hard-code
// these paths independently.
//
// Directory layout:
//
//	~/.nexus-code/          ← Root()
//	~/.nexus-code/bin/      ← BinDir()
//	~/.nexus-code/sockets/  ← SocketsDir()
//	~/.nexus-code/run/      ← RunDir()
//
// Windows is not supported — the project only targets macOS and Linux.
package agentpaths

import (
	"fmt"
	"os"
	"path/filepath"
)

const rootDirName = ".nexus-code"

// Root returns the absolute path of the ~/.nexus-code runtime directory.
// It delegates to os.UserHomeDir() and wraps any error with context.
func Root() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("agentpaths: cannot determine home directory: %w", err)
	}
	return filepath.Join(home, rootDirName), nil
}

// BinDir returns the absolute path of ~/.nexus-code/bin, the directory where
// agent-managed executables (e.g. wrapper scripts) are installed at runtime.
func BinDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "bin"), nil
}

// SocketsDir returns the absolute path of ~/.nexus-code/sockets, the directory
// where Unix domain socket files (e.g. the hook server socket) are placed.
func SocketsDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "sockets"), nil
}

// RunDir returns the absolute path of ~/.nexus-code/run, the directory where
// per-workspace daemon runtime files (Unix socket, lock file, log) are placed.
// Each workspace daemon uses files named <wsId>.{sock,lock,log} inside this
// directory.
func RunDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "run"), nil
}

// EnsureDir creates path and any necessary parents with permission 0700.
// It is idempotent — if path already exists as a directory the call succeeds.
func EnsureDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return fmt.Errorf("agentpaths: cannot create directory %q: %w", path, err)
	}
	return nil
}
