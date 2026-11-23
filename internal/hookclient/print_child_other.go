//go:build !darwin && !linux

package hookclient

import "os/exec"

func preparePrintChild(*exec.Cmd) (func(), error) {
	return func() {}, nil
}
