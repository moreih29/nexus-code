//go:build darwin || linux

package fs

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func openPreviewFile(real string) (*os.File, error) {
	return openCanonicalPath(real, false)
}

func openProtectedDirectory(real string) (*os.File, error) {
	dir, err := openCanonicalPath(real, true)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return openUploadListing(dir)
}

func openCanonicalPath(real string, directory bool) (*os.File, error) {
	const flags = unix.O_CLOEXEC | unix.O_NOFOLLOW
	fd, err := unix.Open("/", flags|previewDirOpenFlags, 0)
	if err != nil {
		return nil, err
	}
	if real == "/" && directory {
		return os.NewFile(uintptr(fd), real), nil
	}
	parts := strings.Split(strings.TrimPrefix(real, "/"), "/")
	for i, part := range parts {
		mode := flags | unix.O_RDONLY | unix.O_NONBLOCK
		if directory || i < len(parts)-1 {
			mode = flags | previewDirOpenFlags
		}
		next, err := unix.Openat(fd, part, mode, 0)
		unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ELOOP) {
				err = FSError{Code: CodeOutOfWorkspace, Path: real}
			}
			return nil, err
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), real), nil
}

func protectedEntrySize(dir *os.File, name string) *int64 {
	var st unix.Stat_t
	if unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil ||
		st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil
	}
	return &st.Size
}
