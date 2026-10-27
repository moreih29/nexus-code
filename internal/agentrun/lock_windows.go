//go:build windows

package agentrun

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

var (
	errLockBusy        = errors.New("agentrun: lock held by another process")
	errLockUnsupported = errors.New("agentrun: file system does not support locks")
)

// stillActive is the exit code GetExitCodeProcess reports for a running process.
const stillActive = 259

// lockFile takes an exclusive, non-blocking LockFileEx lock on f's first
// byte. Like a flock, it is released when f is closed, and a second handle
// to the file — in this process or another — cannot take it meanwhile.
func lockFile(f *os.File) error {
	err := windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, new(windows.Overlapped),
	)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return errLockBusy
	}
	return err
}

// processAlive reports whether pid is a running process. A process this user
// may not open (another user's) counts as alive.
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	return code == stillActive
}
