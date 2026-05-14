//go:build darwin

package pty

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	creackpty "github.com/creack/pty"
)

const helperEnvName = "NEXUS_CREACK_PTY_PARITY_HELPER"

// TestMain turns the test binary into small PTY child programs when a scenario
// starts it through creack/pty; normal test runs keep the standard m.Run path.
func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnvName); mode != "" {
		os.Exit(runHelper(mode))
	}
	os.Exit(m.Run())
}

// TestSetsizeViaTIOCSWINSZUpdatesGeometryAndSendsSIGWINCH proves pty.Setsize
// reaches the child as both terminal geometry and a SIGWINCH notification.
func TestSetsizeViaTIOCSWINSZUpdatesGeometryAndSendsSIGWINCH(t *testing.T) {
	session := startPTY(t, helperCommand("resize-observer"))
	defer session.close()

	session.requireOutput(t, "READY resize-observer", 2*time.Second)
	if err := creackpty.Setsize(session.master, &creackpty.Winsize{Rows: 41, Cols: 132}); err != nil {
		t.Fatalf("resize through pty.Setsize failed: %v", err)
	}
	session.requireOutput(t, "WINCH rows=41 cols=132", 2*time.Second)
	session.requireExit(t, 0, 2*time.Second)
}

// TestChildHasControllingTerminalAndOwnSession checks that pty.Start creates a
// session leader with a usable controlling terminal at /dev/tty.
func TestChildHasControllingTerminalAndOwnSession(t *testing.T) {
	session := startPTY(t, helperCommand("session-probe"))
	defer session.close()

	session.requireOutput(t, "SESSION_LEADER yes", 2*time.Second)
	session.requireOutput(t, "CTTY_WRITE ok", 2*time.Second)
	session.requireExit(t, 0, 2*time.Second)
}

// TestChildSIGWINCHHandlerRunsOnResize isolates the signal handler path from
// geometry assertions so resize handling is covered as a direct child callback.
func TestChildSIGWINCHHandlerRunsOnResize(t *testing.T) {
	session := startPTY(t, helperCommand("winch-handler"))
	defer session.close()

	session.requireOutput(t, "READY winch-handler", 2*time.Second)
	if err := creackpty.Setsize(session.master, &creackpty.Winsize{Rows: 33, Cols: 111}); err != nil {
		t.Fatalf("resize through pty.Setsize failed: %v", err)
	}
	session.requireOutput(t, "HANDLER sigwinch", 2*time.Second)
	session.requireExit(t, 0, 2*time.Second)
}

// TestControlByteDeliversSIGINTThroughLineDiscipline verifies that writing a
// raw ^C byte to the master side is translated by the terminal into SIGINT.
func TestControlByteDeliversSIGINTThroughLineDiscipline(t *testing.T) {
	session := startPTY(t, helperCommand("sigint-observer"))
	defer session.close()

	session.requireOutput(t, "READY sigint-observer", 2*time.Second)
	if _, err := session.master.Write([]byte{0x03}); err != nil {
		t.Fatalf("write raw ^C to pty master failed: %v", err)
	}
	session.requireOutput(t, "SIGINT delivered", 2*time.Second)
	session.requireExit(t, 0, 2*time.Second)
}

// TestWaitRecoversExitCodeAndSignalTermination covers both successful Wait
// plumbing for normal non-zero exits and signal-terminated children.
func TestWaitRecoversExitCodeAndSignalTermination(t *testing.T) {
	t.Run("exit code", func(t *testing.T) {
		session := startPTY(t, exec.Command("/bin/sh", "-c", "exit 7"))
		defer session.close()

		err := session.wait(2 * time.Second)
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("expected exec.ExitError for code 7, got %T: %v", err, err)
		}
		if got := exitErr.ExitCode(); got != 7 {
			t.Fatalf("exit code mismatch: got %d, want 7", got)
		}
	})

	t.Run("signal", func(t *testing.T) {
		session := startPTY(t, exec.Command("/bin/sleep", "30"))
		defer session.close()

		if err := session.cmd.Process.Signal(syscall.SIGTERM); err != nil {
			t.Fatalf("send SIGTERM to child failed: %v", err)
		}
		err := session.wait(2 * time.Second)
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("expected exec.ExitError for signaled child, got %T: %v", err, err)
		}
		status, ok := exitErr.Sys().(syscall.WaitStatus)
		if !ok {
			t.Fatalf("wait status has unexpected type %T", exitErr.Sys())
		}
		if !status.Signaled() || status.Signal() != syscall.SIGTERM {
			t.Fatalf("signal status mismatch: signaled=%v signal=%v", status.Signaled(), status.Signal())
		}
	})
}

// ptySession owns a started child process and the master-side PTY reader used
// by tests to wait for scenario markers.
type ptySession struct {
	cmd    *exec.Cmd
	master *os.File

	mu     sync.Mutex
	output bytes.Buffer

	readDone chan struct{}
	waitDone chan struct{}
	waitOnce sync.Once
	waitErr  error
}

// helperCommand returns the current test binary configured to run one child
// scenario instead of the regular test suite.
func helperCommand(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperEnvName+"="+mode)
	return cmd
}

// startPTY launches cmd under creack/pty and starts capturing master-side
// output for assertions.
func startPTY(t *testing.T, cmd *exec.Cmd) *ptySession {
	t.Helper()
	master, err := creackpty.Start(cmd)
	if err != nil {
		t.Fatalf("start pty command: %v", err)
	}

	session := &ptySession{
		cmd:      cmd,
		master:   master,
		readDone: make(chan struct{}),
		waitDone: make(chan struct{}),
	}
	go session.captureOutput()
	return session
}

// captureOutput copies all master-side data into the session buffer until the
// PTY closes.
func (s *ptySession) captureOutput() {
	defer close(s.readDone)
	buf := make([]byte, 1024)
	for {
		n, err := s.master.Read(buf)
		if n > 0 {
			s.mu.Lock()
			_, _ = s.output.Write(buf[:n])
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// outputString returns a stable snapshot of the PTY transcript captured so far.
func (s *ptySession) outputString() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.output.String()
}

// requireOutput waits until the PTY transcript includes marker or fails with
// the captured transcript for diagnosis.
func (s *ptySession) requireOutput(t *testing.T, marker string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(s.outputString(), marker) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q in output:\n%s", marker, s.outputString())
}

// wait returns cmd.Wait's result once, with a timeout to keep hung parity
// probes from stalling the suite.
func (s *ptySession) wait(timeout time.Duration) error {
	s.waitOnce.Do(func() {
		go func() {
			s.waitErr = s.cmd.Wait()
			close(s.waitDone)
		}()
	})

	select {
	case <-s.waitDone:
		return s.waitErr
	case <-time.After(timeout):
		return fmt.Errorf("timed out waiting for child exit after %s", timeout)
	}
}

// requireExit checks that the child exits with the exact expected status.
func (s *ptySession) requireExit(t *testing.T, code int, timeout time.Duration) {
	t.Helper()
	err := s.wait(timeout)
	if code == 0 && err == nil {
		return
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("expected exit code %d, got %T: %v; output:\n%s", code, err, err, s.outputString())
	}
	if got := exitErr.ExitCode(); got != code {
		t.Fatalf("exit code mismatch: got %d, want %d; output:\n%s", got, code, s.outputString())
	}
}

// close tears down a PTY session without hiding the earlier test assertion.
func (s *ptySession) close() {
	_ = s.master.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	_ = s.wait(500 * time.Millisecond)
	select {
	case <-s.readDone:
	case <-time.After(500 * time.Millisecond):
	}
}

// runHelper dispatches the child-side scenario selected by helperEnvName.
func runHelper(mode string) int {
	switch mode {
	case "resize-observer":
		return runResizeObserver()
	case "session-probe":
		return runSessionProbe()
	case "winch-handler":
		return runWinchHandler()
	case "sigint-observer":
		return runSigintObserver()
	default:
		fmt.Fprintf(os.Stderr, "unknown helper mode %q\n", mode)
		return 64
	}
}

// runResizeObserver reports readiness, waits for SIGWINCH, then prints the
// terminal size visible from the child side.
func runResizeObserver() int {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	defer signal.Stop(ch)

	fmt.Println("READY resize-observer")
	select {
	case <-ch:
		size, err := creackpty.GetsizeFull(os.Stdin)
		if err != nil {
			fmt.Printf("ERROR getsize: %v\n", err)
			return 2
		}
		fmt.Printf("WINCH rows=%d cols=%d\n", size.Rows, size.Cols)
		return 0
	case <-time.After(5 * time.Second):
		fmt.Println("TIMEOUT sigwinch")
		return 3
	}
}

// runSessionProbe verifies that the process is its own session leader and can
// open/write the controlling terminal.
func runSessionProbe() int {
	pid := os.Getpid()
	sid, err := syscall.Getsid(0)
	if err != nil {
		fmt.Printf("ERROR getsid: %v\n", err)
		return 2
	}
	if sid != pid {
		fmt.Printf("SESSION_LEADER no pid=%d sid=%d\n", pid, sid)
		return 3
	}
	fmt.Printf("SESSION_LEADER yes pid=%d sid=%d\n", pid, sid)

	ctty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		fmt.Printf("CTTY_OPEN error: %v\n", err)
		return 4
	}
	defer ctty.Close()
	if _, err := io.WriteString(ctty, "CTTY_WRITE ok\n"); err != nil {
		fmt.Printf("CTTY_WRITE error: %v\n", err)
		return 5
	}
	return 0
}

// runWinchHandler exits only after the process-level SIGWINCH handler runs.
func runWinchHandler() int {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	defer signal.Stop(ch)

	fmt.Println("READY winch-handler")
	select {
	case <-ch:
		fmt.Println("HANDLER sigwinch")
		return 0
	case <-time.After(5 * time.Second):
		fmt.Println("TIMEOUT sigwinch")
		return 2
	}
}

// runSigintObserver exits only after line discipline converts raw ^C input into
// SIGINT for the foreground child process.
func runSigintObserver() int {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt)
	defer signal.Stop(ch)

	fmt.Println("READY sigint-observer")
	select {
	case <-ch:
		fmt.Println("SIGINT delivered")
		return 0
	case <-time.After(5 * time.Second):
		fmt.Println("TIMEOUT sigint")
		return 2
	}
}
