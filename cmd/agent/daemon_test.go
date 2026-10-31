//go:build !windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentrun"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// shortHome returns a temp dir with a SHORT absolute path for use as the
// daemon's fake HOME. t.TempDir() must not be used here: its path on macOS
// (/var/folders/<...>/T/<TestName><runID>/NNN) plus ".nexus-code/run/<wsId>.sock"
// exceeds the 104-byte sun_path limit depending on the test name and the
// random run ID, making bind(2) fail with EINVAL — a borderline flake.
// /tmp keeps the total far under the cap (see the sun_path note in
// internal/agentrun/paths.go).
func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nxdh-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// startDaemon starts `bin --daemon root` with HOME redirected to fakeHome so
// the daemon writes its socket/lock/log under fakeHome/.nexus-code/run/.
// Returns the started *exec.Cmd and the run directory to poll for the socket.
func startDaemon(t *testing.T, bin, root, fakeHome string) (*exec.Cmd, string) {
	t.Helper()
	nexusRunDir := filepath.Join(fakeHome, ".nexus-code", "run")
	if err := os.MkdirAll(nexusRunDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	cmd := exec.Command(bin, "--daemon", root)
	cmd.Env = append(os.Environ(), "HOME="+fakeHome)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	return cmd, nexusRunDir
}

// waitForSocket polls runDir until a *.sock file appears, then returns its path.
func waitForSocket(t *testing.T, runDir string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(runDir)
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".sock") {
				return filepath.Join(runDir, e.Name())
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Boot failed — dump the run directory and any boot log so the failure
	// is diagnosable from CI output alone.
	entries, _ := os.ReadDir(runDir)
	for _, e := range entries {
		t.Logf("runDir entry: %s", e.Name())
		if strings.HasSuffix(e.Name(), ".log") {
			data, _ := os.ReadFile(filepath.Join(runDir, e.Name()))
			t.Logf("boot log %s:\n%s", e.Name(), data)
		}
	}
	t.Fatal("daemon socket did not appear within 5 s")
	return ""
}

// readReady connects to sockPath and reads the first NDJSON frame (Ready).
// Returns the open conn and the raw JSON string.
func readReady(t *testing.T, sockPath string) (net.Conn, string) {
	t.Helper()
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", sockPath, err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	sc := bufio.NewScanner(conn)
	if !sc.Scan() {
		conn.Close()
		t.Fatalf("no frame from daemon: %v", sc.Err())
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, sc.Text()
}

// TestDaemonTakeover verifies the silent-disconnect takeover semantics:
//   - dialer A connects and receives a Ready frame
//   - dialer B connects while A is still alive
//   - the daemon closes A's connection (takeover) and serves B
//   - B receives its own Ready frame with the same agentEpoch as A (same daemon)
//   - after takeover A's conn is closed — read returns an error
//
// PTY survival is structural: pty.Close is only called inside cleanupAndExit,
// which is not reachable via the preempted code path.
func TestDaemonTakeover(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	sockPath := waitForSocket(t, runDir)

	// Dialer A.
	connA, lineA := readReady(t, sockPath)
	defer connA.Close()
	var frameA map[string]any
	if err := json.Unmarshal([]byte(lineA), &frameA); err != nil {
		t.Fatalf("parse A ready: %v", err)
	}
	if frameA["type"] != "ready" {
		t.Fatalf("A: want ready, got %s", lineA)
	}

	// Dialer B — arrives while A is still connected.
	connB, lineB := readReady(t, sockPath)
	defer connB.Close()
	var frameB map[string]any
	if err := json.Unmarshal([]byte(lineB), &frameB); err != nil {
		t.Fatalf("parse B ready: %v", err)
	}
	if frameB["type"] != "ready" {
		t.Fatalf("B: want ready, got %s", lineB)
	}

	// Both frames must come from the same daemon instance.
	if frameA["agentEpoch"] != frameB["agentEpoch"] {
		t.Errorf("epoch mismatch A=%v B=%v — different daemon instances", frameA["agentEpoch"], frameB["agentEpoch"])
	}

	// A's connection must have been closed by the takeover.
	_ = connA.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 1)
	_, err := connA.Read(buf)
	if err == nil {
		t.Error("dialer A conn still readable after takeover — expected EOF or read error")
	}
}

// TestDaemonLongSessionThenReattach is the regression test for the E2E ② bug:
// a dialer that stays connected longer than reattachGrace must not kill the
// daemon's acceptor, and a subsequent clean disconnect must allow reattach.
//
// With the buggy code (acceptor deadline on every Accept), the acceptor would
// die after 300 s of no *new* connections (even while A was actively serving),
// then A's clean EOF would hit a closed graceExpired channel and immediately
// self-terminate — no reattach possible.
//
// A test cannot wait out the 300 s, so this one checks the part it can: after
// A disconnects cleanly, the same daemon serves the next dialer.
func TestDaemonLongSessionThenReattach(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	sockPath := waitForSocket(t, runDir)

	// Dialer A: connect, get Ready.
	connA, lineA := readReady(t, sockPath)
	var frameA map[string]any
	if err := json.Unmarshal([]byte(lineA), &frameA); err != nil {
		t.Fatalf("parse A ready: %v", err)
	}
	if frameA["type"] != "ready" {
		t.Fatalf("A: not a ready frame: %s", lineA)
	}

	// Close A cleanly (EOF). In the buggy code this would trigger immediate
	// daemon self-termination if the graceExpired channel had already been
	// closed by the acceptor.
	_ = connA.Close()

	// Dialer B: must succeed and receive Ready.
	connB, lineB := readReady(t, sockPath)
	defer connB.Close()

	var frameB map[string]any
	if err := json.Unmarshal([]byte(lineB), &frameB); err != nil {
		t.Fatalf("parse B ready: %v", err)
	}
	if frameB["type"] != "ready" {
		t.Fatalf("B: expected ready after reattach, got: %s", lineB)
	}
	// Same epoch: same daemon instance served both dialers.
	if frameA["agentEpoch"] != frameB["agentEpoch"] {
		t.Errorf("epoch mismatch: A=%v B=%v — daemon was replaced, not reattached",
			frameA["agentEpoch"], frameB["agentEpoch"])
	}
}

// TestDaemonTakeoverResumesPausedPTY is the regression test for the
// reconnected-but-frozen terminal: dialer A reads PTY output but never acks it
// (a renderer that vanished while the socket still absorbed writes), so the
// session pauses at the high watermark with ~100 KB of debt. After dialer B
// takes over, that stale debt must be dropped and the rest of the output must
// reach B; before ResetFlowControl was wired in, the session stayed paused
// forever.
func TestDaemonTakeoverResumesPausedPTY(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir)

	connA, _ := readReady(t, sockPath)
	defer connA.Close()
	spawn, _ := json.Marshal(map[string]any{
		"id": "spawn", "method": "pty.spawn",
		"params": map[string]any{
			"workspaceId": "ws", "tabId": "tab", "cwd": root, "cols": 80, "rows": 24,
			"shell": "/bin/sh",
			// 150 KB pauses the session at the 100 KB watermark while A never
			// acks; what is left after the pause still fits in B's window.
			"args": []string{"-c", "stty -echo; head -c 150000 /dev/zero | tr '\\0' a; echo; echo END-MARKER; sleep 30"},
		},
	})
	if _, err := connA.Write(append(spawn, '\n')); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	// Drain A without acking until the output stops (the session paused).
	got := 0
	for {
		_ = connA.SetReadDeadline(time.Now().Add(time.Second))
		n, err := connA.Read(make([]byte, 64*1024))
		got += n
		if err != nil {
			break
		}
	}
	if got < 100_000 {
		t.Fatalf("dialer A received only %d bytes before the pause", got)
	}

	connB, _ := readReady(t, sockPath)
	defer connB.Close()
	_ = connB.SetReadDeadline(time.Now().Add(5 * time.Second))
	sc := bufio.NewScanner(connB)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	var tail strings.Builder
	for sc.Scan() {
		var frame struct {
			Event   string `json:"event"`
			Payload struct {
				Chunk string `json:"chunk"`
			} `json:"payload"`
		}
		if json.Unmarshal(sc.Bytes(), &frame) != nil || frame.Event != "pty.data" {
			continue
		}
		chunk, _ := base64.StdEncoding.DecodeString(frame.Payload.Chunk)
		tail.Write(chunk)
		if strings.Contains(tail.String(), "END-MARKER") {
			return
		}
	}
	t.Fatalf("dialer B never received the output left after the pause (got %d bytes): %v", tail.Len(), sc.Err())
}

// A daemon of another workspace sweeping stale run files takes this
// workspace's lock for a moment to prove its daemon dead. A daemon starting in
// that moment must wait it out instead of exiting with ExitCodeLockHeld as if
// a daemon were already running.
func TestDaemonStartsWhileLockBrieflyHeld(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)
	runDir := filepath.Join(fakeHome, ".nexus-code", "run")
	if err := os.MkdirAll(runDir, 0700); err != nil {
		t.Fatal(err)
	}
	lockFile, err := os.OpenFile(filepath.Join(runDir, agentrun.WsID(root, proto.ServerVersion)+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}

	cmd, _ := startDaemon(t, bin, root, fakeHome)
	exited := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		close(exited)
	}()
	defer func() {
		_ = cmd.Process.Kill()
		<-exited
	}()

	// The daemon opens its log right before it takes the lock.
	logPath := filepath.Join(runDir, agentrun.WsID(root, proto.ServerVersion)+".log")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if _, err := os.Stat(logPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("daemon did not open its log within 5 s")
		}
	}
	time.Sleep(30 * time.Millisecond)
	_ = lockFile.Close()

	select {
	case <-exited:
		t.Fatalf("daemon exited while the lock was briefly held: %v", waitErr)
	case <-time.After(300 * time.Millisecond):
	}
	conn, ready := readReady(t, waitForSocket(t, runDir))
	defer conn.Close()
	if !strings.Contains(ready, `"ready"`) {
		t.Fatalf("want ready frame, got %s", ready)
	}
}
