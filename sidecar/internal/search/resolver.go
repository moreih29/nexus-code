package search

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const ripgrepBinaryName = "rg"

type RipgrepResolver func() (string, error)

func ResolveRipgrepPath() (string, error) {
	if explicit := os.Getenv("NEXUS_RIPGREP_PATH"); explicit != "" {
		if isExecutableFile(explicit) {
			return explicit, nil
		}
	}

	for _, candidate := range ripgrepCandidates() {
		if isExecutableFile(candidate) {
			return candidate, nil
		}
	}

	if fromPath, err := exec.LookPath(ripgrepExecutableName()); err == nil {
		return fromPath, nil
	}

	return "", exec.ErrNotFound
}

func ripgrepCandidates() []string {
	name := ripgrepExecutableName()
	candidates := []string{}

	if executablePath, err := os.Executable(); err == nil {
		executableDir := filepath.Dir(executablePath)
		parentDir := filepath.Dir(executableDir)
		candidates = append(candidates,
			filepath.Join(executableDir, name),
			filepath.Join(executableDir, "ripgrep", name),
			filepath.Join(executableDir, "ripgrep", platformArch(), name),
			filepath.Join(parentDir, "ripgrep", name),
			filepath.Join(parentDir, "ripgrep", platformArch(), name),
		)
	}

	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "bin", name),
			filepath.Join(cwd, "ripgrep", name),
			filepath.Join(cwd, "ripgrep", platformArch(), name),
		)
	}

	return candidates
}

func ripgrepExecutableName() string {
	if runtime.GOOS == "windows" {
		return ripgrepBinaryName + ".exe"
	}
	return ripgrepBinaryName
}

func platformArch() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func classifySearchStartError(err error) (bool, string) {
	if errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err) {
		return true, "ripgrep is not available from the bundled binary locations or PATH."
	}
	return false, err.Error()
}
