//go:build unix

package claudefiles

import (
	"os"
	"syscall"
)

func linked(_ *os.File, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || stat.Nlink > 1
}
