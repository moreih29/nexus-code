package agentpaths

import (
	"fmt"
	"os"
	"path/filepath"
)

const rootDirName = ".nexus-code"

const HomeEnv = "NEXUS_CODE_HOME"

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

func BinDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "bin"), nil
}

func SocketsDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "sockets"), nil
}

func RunDir() (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "run"), nil
}

func EnsureDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return fmt.Errorf("agentpaths: cannot create directory %q: %w", path, err)
	}
	return nil
}
