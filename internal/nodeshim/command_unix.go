//go:build !windows

package nodeshim

import "os/exec"

func Command(path string, args ...string) *exec.Cmd {
	return exec.Command(path, args...)
}
