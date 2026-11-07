//go:build !windows

package hookclient

import "os/exec"

// programCommand runs the program at `path`, which the wrapper found on
// PATH.
func programCommand(path string, args ...string) *exec.Cmd {
	return exec.Command(path, args...)
}
