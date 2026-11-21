package lsp

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func observeServerExit(process *os.Process) bool {
	syscall.ForkLock.RLock()
	kq, err := unix.Kqueue()
	if err == nil {
		unix.CloseOnExec(kq)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return false
	}
	defer unix.Close(kq)
	event := unix.Kevent_t{
		Ident: uint64(process.Pid), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT,
	}
	if _, err := unix.Kevent(kq, []unix.Kevent_t{event}, nil, nil); err != nil {
		return errors.Is(err, unix.ESRCH)
	}
	events := make([]unix.Kevent_t, 1)
	for {
		count, err := unix.Kevent(kq, nil, events, nil)
		if !errors.Is(err, unix.EINTR) {
			return err == nil && count == 1 && events[0].Flags&unix.EV_ERROR == 0
		}
	}
}
