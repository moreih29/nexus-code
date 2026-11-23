package hookclient

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

const printChildArg = "--print-child"
const printWatcherArg = "--print-child-watch"

func preparePrintChild(cmd *exec.Cmd) (func(), error) {
	if cmd.Err != nil {
		return nil, cmd.Err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	read, write, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Args = append([]string{self, printChildArg, cmd.Path}, cmd.Args...)
	cmd.Path = self
	cmd.ExtraFiles = []*os.File{read}
	return func() {
		_ = read.Close()
		_ = write.Close()
	}, nil
}

func PrintChildHelper(args []string) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case printChildArg:
		if len(args) < 3 {
			return 2, true
		}
		if err := execWatchedPrintChild(args[1], args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "nexus: %v\n", err)
			return 127, true
		}
	case printWatcherArg:
		if len(args) != 2 {
			return 2, true
		}
		pid, err := strconv.Atoi(args[1])
		if err != nil || pid <= 1 {
			return 2, true
		}
		if err := watchPrintChild(pid); err != nil {
			fmt.Fprintf(os.Stderr, "nexus: print child watcher: %v\n", err)
			return 1, true
		}
	default:
		return 0, false
	}
	return 0, true
}

func execWatchedPrintChild(path string, args []string) error {
	parent := os.NewFile(3, "print recorder lifetime")
	defer parent.Close()
	unix.CloseOnExec(int(parent.Fd()))
	self, err := os.Executable()
	if err != nil {
		return err
	}
	ready, readyWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer ready.Close()
	watcher, err := os.StartProcess(self, []string{self, printWatcherArg, strconv.Itoa(os.Getpid())}, &os.ProcAttr{
		Files: []*os.File{parent, readyWrite, os.Stderr},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	})
	_ = readyWrite.Close()
	if err != nil {
		return err
	}
	var armed [1]byte
	if _, err := io.ReadFull(ready, armed[:]); err != nil {
		_, _ = watcher.Wait()
		return fmt.Errorf("arm print child watcher: %w", err)
	}
	_ = watcher.Release()
	return syscall.Exec(path, args, os.Environ())
}

func watchPrintChild(pid int) error {
	if os.Getppid() != pid {
		return nil
	}
	queue, err := unix.Kqueue()
	if err != nil {
		return err
	}
	defer unix.Close(queue)
	filters := []unix.Kevent_t{
		{Ident: uint64(os.Stdin.Fd()), Filter: unix.EVFILT_READ, Flags: unix.EV_ADD},
		{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD, Fflags: unix.NOTE_EXIT},
	}
	if _, err := unix.Kevent(queue, filters, nil, nil); err != nil {
		return err
	}
	if _, err := os.Stdout.Write([]byte{1}); err != nil {
		return err
	}
	_ = os.Stdout.Close()

	var events [2]unix.Kevent_t
	for {
		n, err := unix.Kevent(queue, nil, events[:], nil)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		for _, event := range events[:n] {
			if event.Filter == unix.EVFILT_PROC {
				return nil
			}
		}
		for _, event := range events[:n] {
			if event.Filter == unix.EVFILT_READ && event.Flags&unix.EV_EOF != 0 {
				if os.Getppid() == pid {
					_ = unix.Kill(pid, unix.SIGKILL)
				}
				return nil
			}
		}
	}
}
