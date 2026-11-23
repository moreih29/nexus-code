//go:build !linux && !windows

package pty

import "os"

func pollableMaster(master *os.File) *os.File {
	return master
}
