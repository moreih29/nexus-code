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

// terminal is the master side of the PTY a session's shell runs under.
type terminal struct {
	*os.File
}

// shellFallbackCandidates is the ordered probe list used only when $SHELL
// is absent from the agent environment. bash precedes zsh deliberately: an
// unconfigured zsh drops the user into the interactive zsh-newuser-install
// wizard, so it is the worse default. New shells can be appended here.
var shellFallbackCandidates = []string{"/bin/bash", "/bin/zsh", "/bin/sh"}

// defaultShell resolves the shell for a PTY on the agent's own host. It
// prefers $SHELL — the user's configured login shell, which the remote
// sshd populates from /etc/passwd — and only when that is unset probes
// shellFallbackCandidates so a missing $SHELL never spawns a nonexistent
// binary.
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

// startTerminal starts spec's shell under a new PTY.
func startTerminal(spec spawnSpec) (*terminal, *child, error) {
	cmd := exec.Command(spec.shell, spec.args...)
	cmd.Dir = spec.dir
	cmd.Env = spec.env
	cmd.SysProcAttr = newSysProcAttr()

	master, err := creackpty.StartWithSize(cmd, &creackpty.Winsize{Rows: uint16(spec.rows), Cols: uint16(spec.cols)})
	if err != nil {
		return nil, nil, err
	}
	// From here on the master must not go through os.File.Fd(): that would
	// put it back into blocking mode (see pollableMaster and withFd).
	return &terminal{pollableMaster(master)}, &child{cmd.Process}, nil
}

// setSize applies a geometry to the PTY. It replaces creackpty.Setsize,
// which reaches the descriptor through os.File.Fd(): that read is not
// synchronized with a concurrent Close (a data race, and an ioctl on a
// possibly reused descriptor number), which resize and the post-replay
// wiggle hit whenever the session is torn down at the same time.
func (t *terminal) setSize(cols, rows int) error {
	return withFd(t.File, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(rows), Col: uint16(cols)})
	})
}

// foregroundProcess returns the basename of the program in the PTY's
// foreground process group, or "" when it cannot be told.
//
// TIOCGPGRP on the master gives the foreground process group id, then
// `ps -o comm= -p PGID` resolves the program name. The leading path is
// stripped so callers see "lazygit" rather than "/usr/local/bin/lazygit".
func (t *terminal) foregroundProcess() string {
	var pgid int
	ioErr := withFd(t.File, func(fd int) (err error) {
		pgid, err = unix.IoctlGetInt(fd, unix.TIOCGPGRP)
		return err
	})
	if ioErr != nil || pgid <= 0 {
		return ""
	}
	// `ps -o comm= -p PGID`: -o comm= prints only the COMM column (no header),
	// macOS와 Linux 모두 동일한 형태로 동작. 짧은 실행 시간(~30ms)이라 alt-enter
	// 같은 sporadic 호출에는 충분.
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pgid)).Output()
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(out))
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	return name
}

// withFd runs fn with the master's descriptor held open: SyscallConn's
// Control keeps the file from being closed underneath fn and fails cleanly
// once it has been closed, unlike os.File.Fd().
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

// sameEnvKey reports whether two environment variable names name the same
// variable.
func sameEnvKey(a, b string) bool {
	return a == b
}
