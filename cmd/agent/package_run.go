package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/msix"
)

func runPackageProgram(argv []string) int {
	if len(argv) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: agent package-run <program> [args...]")
		return 2
	}
	installDir, ok := msix.InstallDir()
	if !ok {
		fmt.Fprintln(os.Stderr, "agent package-run: the agent does not run from an MSIX package")
		return 1
	}
	if !inDir(installDir, argv[0]) {
		fmt.Fprintf(os.Stderr, "agent package-run: %s is not in the package\n", argv[0])
		return 1
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent package-run: %v\n", err)
		return 1
	}
	return 0
}

func inDir(dir string, path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != "." && filepath.IsLocal(rel)
}
