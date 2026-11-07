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
// On Windows, ~ is the user profile folder (USERPROFILE), for both modules.
// NEXUS_CODE_HOME names another root in place of ~/.nexus-code, for both.
package agentpaths

import (
	"fmt"
	"os"
	"path/filepath"
)

const rootDirName = ".nexus-code"

// HomeEnv names a runtime directory in place of ~/.nexus-code: a copy of the
// app run beside the installed one, as a build under test, keeps its files
// and the installed app's apart.
const HomeEnv = "NEXUS_CODE_HOME"

// Root returns the absolute path of the ~/.nexus-code runtime directory, or
// of the one NEXUS_CODE_HOME names. It delegates to os.UserHomeDir() and
// wraps any error with context.
func Root() (string, error) {
	if named := os.Getenv(HomeEnv); named != "" {
		return filepath.Abs(named)
	}
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
