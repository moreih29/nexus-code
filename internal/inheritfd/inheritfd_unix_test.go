//go:build unix

package inheritfd

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func closeOnExec(t *testing.T, fd int) bool {
	t.Helper()
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("F_GETFD %d: %v", fd, err)
	}
	return flags&unix.FD_CLOEXEC != 0
}

// An inherited descriptor (opened without O_CLOEXEC, as Chromium leaves
// its own) is marked, and a program started afterwards does not get it.
func TestCloseOnExecKeepsInheritedFromChildren(t *testing.T) {
	fd, err := unix.Open(os.DevNull, unix.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if closeOnExec(t, fd) {
		t.Fatal("precondition: the descriptor should start inheritable")
	}
	stdout := closeOnExec(t, 1)

	CloseOnExec()

	if !closeOnExec(t, fd) {
		t.Fatalf("descriptor %d is still inherited", fd)
	}
	if closeOnExec(t, 1) != stdout {
		t.Fatal("stdout's close-on-exec flag changed")
	}
	out, err := exec.Command("/bin/sh", "-c", "ls /dev/fd/").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range strings.Fields(string(out)) {
		if name == strconv.Itoa(fd) {
			t.Fatalf("child still sees descriptor %d: %q", fd, out)
		}
	}
}
