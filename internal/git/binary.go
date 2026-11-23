package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func gitBinary() string {
	return findGit(exec.LookPath, gitInstallPaths(runtime.GOOS, os.Getenv), isRegularFile)
}

func findGit(lookPath func(string) (string, error), candidates []string, exists func(string) bool) string {
	if _, err := lookPath("git"); err == nil {
		return "git"
	}
	for _, candidate := range candidates {
		if exists(candidate) {
			return candidate
		}
	}
	return "git"
}

func gitInstallPaths(goos string, getenv func(string) string) []string {
	if goos != "windows" {
		return nil
	}
	var paths []string
	for _, dir := range []string{
		getenv("ProgramW6432"),
		getenv("ProgramFiles(x86)"),
		getenv("ProgramFiles"),
		joinIfSet(getenv("LOCALAPPDATA"), "Programs"),
	} {
		if dir != "" {
			paths = append(paths, filepath.Join(dir, "Git", "cmd", "git.exe"))
		}
	}
	return paths
}

func joinIfSet(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
