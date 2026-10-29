package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/msix"
)

// runPackageProgram runs a program of the agent's own MSIX package with
// argv's arguments, the agent's standard streams and environment, and
// returns its exit code. Only a process with the package's identity may run
// the package's files, and a program outside the package (git, which runs
// the app as its commit message editor) has none; it starts this through
// the package's alias for the agent, which has.
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

// inDir reports whether path names a file inside dir.
func inDir(dir string, path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != "." && filepath.IsLocal(rel)
}
