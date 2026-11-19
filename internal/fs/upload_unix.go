//go:build darwin || linux

package fs

import (
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// Capture the inherited mask during package initialization, before requests
// can create files. Chmod at publish time must apply the mask explicitly.
var newUploadMode = func() os.FileMode {
	mask := unix.Umask(0o777)
	unix.Umask(mask)
	return 0o666 &^ os.FileMode(mask)
}()

func openUploadParent(path string) (*os.File, error) {
	return openCanonicalPath(path, true)
}

// The upload's parent handle only has search access. Open a listing
// relative to it so a path rename cannot redirect the sweep.
func openUploadListing(dir *os.File) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), dir.Name()), nil
}

func removeStaleUploadAt(dir *os.File, name string, cutoff time.Time) {
	var info unix.Stat_t
	if unix.Fstatat(int(dir.Fd()), name, &info, unix.AT_SYMLINK_NOFOLLOW) == nil &&
		info.Mode&unix.S_IFMT == unix.S_IFREG &&
		time.Unix(int64(info.Mtim.Sec), int64(info.Mtim.Nsec)).Before(cutoff) {
		_ = removeUploadAt(dir, name)
	}
}

func availableUploadSpace(dir *os.File) (*uploadSpace, error) {
	fd := int(dir.Fd())
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	var space unix.Statfs_t
	if err := unix.Fstatfs(fd, &space); err != nil {
		return nil, err
	}
	return &uploadSpace{volume: uint64(stat.Dev), free: uint64(space.Bavail) * uint64(space.Bsize)}, nil
}

func createUploadAt(dir *os.File, name string) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_CREAT|unix.O_EXCL|unix.O_RDWR|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), filepath.Join(dir.Name(), name)), nil
}

func mkdirUploadAt(dir *os.File, name string) error {
	return unix.Mkdirat(int(dir.Fd()), name, 0o777)
}

func sameUploadAt(dir *os.File, name string, file *os.File) bool {
	var opened, named unix.Stat_t
	return unix.Fstat(int(file.Fd()), &opened) == nil &&
		unix.Fstatat(int(dir.Fd()), name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil &&
		opened.Dev == named.Dev && opened.Ino == named.Ino
}

func removeUploadAt(dir *os.File, name string) error {
	return unix.Unlinkat(int(dir.Fd()), name, 0)
}

func publishUploadAt(dir *os.File, temp, target string, file *os.File, existing os.FileInfo) error {
	mode := newUploadMode
	if existing != nil {
		mode = existing.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	fd := int(dir.Fd())
	return unix.Renameat(fd, temp, fd, target)
}
