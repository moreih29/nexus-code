//go:build unix

package inheritfd

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

func CloseOnExec() {
	dir, err := os.Open("/dev/fd")
	if err != nil {
		return
	}
	defer dir.Close()
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return
	}
	for _, name := range names {
		fd, err := strconv.Atoi(name)
		if err != nil || fd <= 2 {
			continue
		}
		unix.CloseOnExec(fd)
	}
}
