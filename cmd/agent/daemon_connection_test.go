//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentrun"
	"github.com/nexus-code/nexus-code/internal/proto"
	"golang.org/x/sys/unix"
)

// dialerProcess is an `agent --dial` run as the SSH session runs it, its
// stdin and stdout pipes held by the test.
type dialerProcess struct {
	cmd    *exec.Cmd
	stdin  *os.File
	stdout *os.File
	lines  *bufio.Scanner
	exited chan struct{}
	err    error
}

func startDialer(t *testing.T, bin, sock string) *dialerProcess {
	t.Helper()
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "--dial", sock)
	cmd.Stdin = inR
	cmd.Stdout = outW
	if err := cmd.Start(); err != nil {
		t.Fatalf("start dialer: %v", err)
	}
	_ = inR.Close()
	_ = outW.Close()
	d := &dialerProcess{cmd: cmd, stdin: inW, stdout: outR, exited: make(chan struct{})}
	d.lines = bufio.NewScanner(outR)
	d.lines.Buffer(make([]byte, 0, 64*1024), 1<<20)
	go func() {
		d.err = cmd.Wait()
		close(d.exited)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-d.exited
		_ = inW.Close()
		_ = outR.Close()
	})
	return d
}

// nextLine reads the dialer's next stdout line, or fails the test.
func (d *dialerProcess) nextLine(t *testing.T) string {
	t.Helper()
	_ = d.stdout.SetReadDeadline(time.Now().Add(5 * time.Second))
	if !d.lines.Scan() {
		t.Fatalf("dialer said nothing more: %v", d.lines.Err())
	}
	return d.lines.Text()
}

// exitCode waits for the dialer to end and returns its exit code, or fails
// the test when it is still running after within.
func (d *dialerProcess) exitCode(t *testing.T, within time.Duration) int {
	t.Helper()
	select {
	case <-d.exited:
	case <-time.After(within):
		t.Fatalf("dialer still running %v later", within)
	}
	var exitErr *exec.ExitError
	switch {
	case d.err == nil:
		return 0
	case errors.As(d.err, &exitErr):
		return exitErr.ExitCode()
	default:
		t.Fatalf("dialer: %v", d.err)
		return -1
	}
}

// daemonLog is what the daemon of root wrote to its run log so far.
func daemonLog(runDir, root string) string {
	data, _ := os.ReadFile(filepath.Join(runDir, agentrun.WsID(root, proto.ServerVersion)+".log"))
	return string(data)
}

// waitForUnreadOutput observes pending data without consuming it, so the
// connection really closes with unread bytes.
func waitForUnreadOutput(t *testing.T, conn net.Conn) {
	t.Helper()
	raw, err := conn.(*net.UnixConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	var n int
	var readErr error
	if err := raw.Read(func(fd uintptr) bool {
		var firstByte [1]byte
		n, _, readErr = unix.Recvfrom(int(fd), firstByte[:], unix.MSG_PEEK)
		return readErr != unix.EAGAIN && readErr != unix.EWOULDBLOCK
	}); err != nil {
		t.Fatal(err)
	}
	if n != 1 || readErr != nil {
		t.Fatalf("daemon had no unread output: n=%d err=%v", n, readErr)
	}
}

// waitForDialerLog waits for the daemon to record its disconnect decision
// before another connection can turn that decision into a takeover.
func waitForDialerLog(t *testing.T, runDir, root string, matches func(string) bool) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for {
		if log := daemonLog(runDir, root); matches(log) {
			return
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatalf("daemon did not record the expected disconnect:\n%s", daemonLog(runDir, root))
		}
	}
}

// A connection that ends with a reset rather than a close is a dialer gone
// mid-output: the SSH session ended under it while the daemon still wrote, and
// Linux reports a socket closed with unread data as reset. That is a dialer
// leaving like any other; the daemon keeps its terminals for the next one.
func TestDaemonSurvivesAResetConnection(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	first, readyA := readReady(t, sockPath)
	defer first.Close()
	spawnOn(t, first, "tab", root, "while :; do echo tick; sleep 0.01; done")
	waitForUnreadOutput(t, first)
	_ = first.Close()
	waitForDialerLog(t, runDir, root, func(log string) bool {
		return strings.Contains(log, "dialer connection broke") ||
			(runtime.GOOS != "linux" && strings.Contains(log, "dialer disconnected cleanly"))
	})

	next, readyB := readReady(t, sockPath)
	defer next.Close()
	var a, b struct {
		AgentEpoch uint64 `json:"agentEpoch"`
	}
	_ = json.Unmarshal([]byte(readyA), &a)
	_ = json.Unmarshal([]byte(readyB), &b)
	if a.AgentEpoch == 0 || a.AgentEpoch != b.AgentEpoch {
		t.Fatalf("another daemon answered: epoch %d, then %d", a.AgentEpoch, b.AgentEpoch)
	}
	result, callErr := callOn(t, next, "list", "session.list", "")
	if len(callErr) > 0 && string(callErr) != "null" {
		t.Fatalf("session.list: %s", callErr)
	}
	if !strings.Contains(string(result), `"tabId":"tab"`) {
		t.Fatalf("the terminal did not outlive the reset connection: %s", result)
	}
	_, _ = next.Write([]byte(`{"id":"bye","method":"agent.shutdown"}` + "\n"))
}

// A dialer whose output closed — the SSH session ending under it — still
// reads what the daemon sends until the daemon closes, so it leaves no unread
// data that turns its close into a reset.
func TestDialerWithItsOutputClosedLeavesTheDaemonCleanly(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	dialer := startDialer(t, bin, sockPath)
	if ready := dialer.nextLine(t); !strings.Contains(ready, `"ready"`) {
		t.Fatalf("want ready frame, got %s", ready)
	}
	spawn, _ := json.Marshal(map[string]any{
		"id": "spawn", "method": "pty.spawn",
		"params": map[string]any{
			"workspaceId": "ws", "tabId": "tab", "cwd": root, "cols": 80, "rows": 24,
			"shell": "/bin/sh", "args": []string{"-c", "while :; do echo tick; sleep 0.01; done"},
		},
	})
	if _, err := dialer.stdin.Write(append(spawn, '\n')); err != nil {
		t.Fatal(err)
	}
	for !strings.Contains(dialer.nextLine(t), `"event":"pty.data"`) {
	}
	_ = dialer.stdout.Close()
	// The ping reply still has to be drained after the output pipe closes.
	if _, err := dialer.stdin.Write([]byte(`{"id":"p","method":"ping"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	_ = dialer.stdin.Close()
	if code := dialer.exitCode(t, 5*time.Second); code != 0 {
		t.Fatalf("dialer exit code %d, want 0", code)
	}
	waitForDialerLog(t, runDir, root, func(log string) bool {
		return strings.Contains(log, "dialer disconnected cleanly")
	})
	if next, _ := readReady(t, sockPath); next != nil {
		_, _ = next.Write([]byte(`{"id":"bye","method":"agent.shutdown"}` + "\n"))
		_ = next.Close()
	}
}

// A dialer whose daemon went away — killed, crashed, or exited — ends at
// once and not as a clean exit, so the app reconnects (and starts a new
// daemon) instead of taking the workspace for closed.
func TestDialerEndsWhenItsDaemonGoes(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	dialer := startDialer(t, bin, sockPath)
	_ = dialer.nextLine(t)
	if err := cmd.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if code := dialer.exitCode(t, 3*time.Second); code != ExitCodeDaemonClosed {
		t.Fatalf("dialer exit code %d, want %d", code, ExitCodeDaemonClosed)
	}
}

// A dialer that another one took the daemon from is told so before its
// connection closes: the app must not reconnect it, or two workspaces on one
// remote folder would take the daemon from each other without end.
func TestDialerTakenOverIsToldSo(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	dialer := startDialer(t, bin, sockPath)
	_ = dialer.nextLine(t)
	next, _ := readReady(t, sockPath)
	defer next.Close()

	last := ""
	_ = dialer.stdout.SetReadDeadline(time.Now().Add(5 * time.Second))
	for dialer.lines.Scan() {
		last = dialer.lines.Text()
	}
	var frame struct {
		Event string `json:"event"`
	}
	if json.Unmarshal([]byte(last), &frame) != nil || frame.Event != preemptedEvent {
		t.Fatalf("last frame the taken-over dialer got: %q", last)
	}
	if code := dialer.exitCode(t, 3*time.Second); code != ExitCodeDaemonClosed {
		t.Fatalf("dialer exit code %d, want %d", code, ExitCodeDaemonClosed)
	}
}

// A dialer whose app closed its side ends cleanly, and the daemon waits for
// the next one.
func TestDialerEndsCleanlyWhenTheAppCloses(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	dialer := startDialer(t, bin, sockPath)
	_ = dialer.nextLine(t)
	_ = dialer.stdin.Close()
	if code := dialer.exitCode(t, 3*time.Second); code != 0 {
		t.Fatalf("dialer exit code %d, want 0", code)
	}
	next, ready := readReady(t, sockPath)
	defer next.Close()
	if !strings.Contains(ready, `"ready"`) {
		t.Fatalf("want ready frame, got %s", ready)
	}
}

// Each dialer's first frame is Ready, even while a terminal pours out
// output: the client takes the first frame it gets for the handshake, and an
// event ahead of Ready reads as an agent without an epoch.
func TestDaemonGreetsEachDialerWithReadyFirst(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	conn, _ := readReady(t, sockPath)
	spawnOn(t, conn, "tab", root, "yes")
	frames := newPtyFrames(conn)
	if output, _ := frames.until(t, conn, 3*time.Second, func(text string, _ bool) bool { return text != "" }); output == "" {
		t.Fatal("terminal never started writing")
	}
	for i := 0; i < 60; i++ {
		next, first := readReady(t, sockPath)
		_ = conn.Close()
		conn = next
		if !strings.Contains(first, `"type":"ready"`) {
			_ = conn.Close()
			t.Fatalf("dialer %d got %.120s before Ready", i, first)
		}
	}
	_, _ = conn.Write([]byte(`{"id":"bye","method":"agent.shutdown"}` + "\n"))
	_ = conn.Close()
}
