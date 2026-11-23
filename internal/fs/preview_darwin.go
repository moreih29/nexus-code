package fs

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

const previewDirOpenFlags = 0x40000000 | unix.O_DIRECTORY

func previewFileStamp(file *os.File, info os.FileInfo, versioned bool) (previewStamp, bool) {
	stat := info.Sys().(*syscall.Stat_t)
	stamp := previewStamp{uint64(stat.Dev), stat.Ino, stat.Ctimespec.Nano()}
	var volume unix.Statfs_t
	return stamp, versioned && stamp.change > 0 && unix.Fstatfs(int(file.Fd()), &volume) == nil &&
		unix.ByteSliceToString(volume.Fstypename[:]) == "apfs" && volume.Flags&unix.MNT_LOCAL != 0
}
