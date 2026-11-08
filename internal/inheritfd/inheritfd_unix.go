//go:build unix

// Package inheritfd keeps the descriptors a process was started with from
// reaching the programs it starts.
package inheritfd

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// CloseOnExec marks every open descriptor above stderr close-on-exec.
//
// Electron on Linux starts the agent with fork and exec (libuv), which hands
// it every descriptor Chromium holds without close-on-exec: its IPC sockets,
// resource packs, GPU cache, a DevTools port when one is open. Go passes on
// whatever is not close-on-exec to every program it starts, so all of them
// reached each terminal's shell and whatever ran in it. The agent needs only
// its stdio. (macOS spawns with POSIX_SPAWN_CLOEXEC_DEFAULT, so nothing comes
// along there; marking is harmless all the same.)
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
