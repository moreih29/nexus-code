//go:build !darwin && !linux

package hookclient

import "os/exec"

// preparePrintChild leaves process setup to the existing platform supervision.
func preparePrintChild(*exec.Cmd) (func(), error) {
	return func() {}, nil
}
