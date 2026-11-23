//go:build darwin || linux

package pty

import (
	"os"
	"os/exec"
	"strconv"
	"strings"

	creackpty "github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type terminal struct {
	*os.File
}

var shellFallbackCandidates = []string{"/bin/bash", "/bin/zsh", "/bin/sh"}

func defaultShell() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	for _, candidate := range shellFallbackCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "/bin/sh"
}

func startTerminal(spec spawnSpec) (*terminal, *child, error) {
	cmd := exec.Command(spec.shell, spec.args...)
	cmd.Dir = spec.dir
	cmd.Env = spec.env
	cmd.SysProcAttr = newSysProcAttr()

	master, err := creackpty.StartWithSize(cmd, &creackpty.Winsize{Rows: uint16(spec.rows), Cols: uint16(spec.cols)})
	if err != nil {
		return nil, nil, err
	}
	return &terminal{pollableMaster(master)}, &child{cmd.Process}, nil
}

func (t *terminal) setSize(cols, rows int) error {
	return withFd(t.File, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(rows), Col: uint16(cols)})
	})
}

func (t *terminal) foregroundProcess(alone bool) (string, *bool) {
	var pgid int
	ioErr := withFd(t.File, func(fd int) (err error) {
		pgid, err = unix.IoctlGetInt(fd, unix.TIOCGPGRP)
		return err
	})
	if ioErr != nil || pgid <= 0 {
		return "", nil
	}
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pgid)).Output()
	if err != nil {
		return "", nil
	}
	name := strings.TrimSpace(string(out))
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	if !alone || name == "" {
		return name, nil
	}
	only := groupAlone(pgid)
	return name, &only
}

func groupAlone(pgid int) bool {
	out, err := exec.Command("ps", "-A", "-o", "pid=,pgid=").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		group, groupErr := strconv.Atoi(fields[1])
		if pidErr == nil && groupErr == nil && group == pgid && pid != pgid {
			return false
		}
	}
	return true
}

func withFd(master *os.File, fn func(fd int) error) error {
	conn, err := master.SyscallConn()
	if err != nil {
		return err
	}
	var fnErr error
	if err := conn.Control(func(fd uintptr) { fnErr = fn(int(fd)) }); err != nil {
		return err
	}
	return fnErr
}

func sameEnvKey(a, b string) bool {
	return a == b
}
