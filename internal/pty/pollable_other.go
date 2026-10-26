//go:build !linux

package pty

import "os"

// pollableMaster keeps the master creack/pty returns. The Linux variant
// exists because a blocking master read there can outlive the shell; macOS
// revokes the terminal when the session leader exits, ending the read.
func pollableMaster(master *os.File) *os.File {
	return master
}
