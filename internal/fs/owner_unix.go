//go:build !windows

package fs

import (
	"os"
	"syscall"
)

// needsInPlaceWrite reports whether replacing the file with a new inode would
// lose something the user cares about: another user's ownership (the new file
// would belong to the agent's user, root included) or other hard links (they
// would keep the old content). Those files are truncated and written in place
// instead, giving up crash atomicity to keep their identity.
func needsInPlaceWrite(_ string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return int(st.Uid) != os.Geteuid() || st.Nlink > 1
}

// keepGroup gives path the group of existing. Best effort: only succeeds when
// the user is in the file's group.
func keepGroup(path string, existing os.FileInfo) {
	if st, ok := existing.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(path, -1, int(st.Gid))
	}
}
