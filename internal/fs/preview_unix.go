//go:build darwin || linux

package fs

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// Open the resolved absolute path one component at a time. O_NOFOLLOW
// protects each component if it changes after the grant's symlink checks.
func openPreviewFile(real string, versioned bool) (*os.File, bool, error) {
	const flags = unix.O_CLOEXEC | unix.O_NOFOLLOW
	fd, err := unix.Open("/", flags|previewDirOpenFlags, 0)
	if err != nil {
		return nil, false, err
	}
	parts := strings.Split(strings.TrimPrefix(real, "/"), "/")
	for i, part := range parts {
		mode := flags | unix.O_RDONLY | unix.O_NONBLOCK
		if i < len(parts)-1 {
			mode = flags | previewDirOpenFlags
		}
		next, err := unix.Openat(fd, part, mode, 0)
		unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ELOOP) {
				err = FSError{Code: CodeOutOfWorkspace, Path: real}
			}
			return nil, false, err
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), real), versioned, nil
}
