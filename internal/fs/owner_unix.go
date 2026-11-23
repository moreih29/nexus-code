//go:build !windows

package fs

import (
	"os"
	"syscall"
)

func needsInPlaceWrite(_ string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return int(st.Uid) != os.Geteuid() || st.Nlink > 1
}

func keepGroup(path string, existing os.FileInfo) {
	if st, ok := existing.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(path, -1, int(st.Gid))
	}
}
