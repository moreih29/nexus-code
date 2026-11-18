package fs

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

const previewDirOpenFlags = unix.O_PATH | unix.O_DIRECTORY

func previewFileStamp(file *os.File, info os.FileInfo, versioned bool) (previewStamp, bool) {
	stat := info.Sys().(*syscall.Stat_t)
	stamp := previewStamp{uint64(stat.Dev), stat.Ino, stat.Ctim.Nano()}
	var volume unix.Statfs_t
	if !versioned || unix.Fstatfs(int(file.Fd()), &volume) != nil {
		return stamp, false
	}
	switch volume.Type {
	case unix.EXT4_SUPER_MAGIC, unix.XFS_SUPER_MAGIC, unix.BTRFS_SUPER_MAGIC, unix.TMPFS_MAGIC:
		return stamp, true
	default:
		return stamp, false
	}
}
