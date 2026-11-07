//go:build !windows

package nodeshim

import "os/exec"

// Command runs the program at `path`, as found on PATH.
func Command(path string, args ...string) *exec.Cmd {
	return exec.Command(path, args...)
}
