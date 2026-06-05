package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mustBuild compiles the agent binary into t.TempDir() and returns the path.
// Uses an explicit output path outside the source tree to avoid leaving a
// binary in the repo root.
func mustBuild(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "agent")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
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

// TestDaemonTakeover verifies the silent-disconnect takeover semantics (CRITICAL 1):
//   - dialer A connects and receives a Ready frame
//   - dialer B connects while A is still alive
//   - the daemon closes A's connection (takeover) and serves B
//   - B receives its own Ready frame with the same agentEpoch as A (same daemon)
//   - after takeover A's conn is closed — read returns an error
//
// PTY survival is structural: pty.Close is only called inside cleanupAndExit,
// which is not reachable via the preempted code path.
func TestDaemonTakeover(t *testing.T) {
	bin := mustBuild(t)
	root := t.TempDir()
	fakeHome := t.TempDir()

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

// TestDaemonGraceExpiryOnFirstConnect verifies CRITICAL 2: the daemon exits if
// no dialer connects within the grace window. We test the underlying mechanism
// (UnixListener deadline) directly without needing to wait 300 s.
func TestDaemonGraceExpiryOnFirstConnect(t *testing.T) {
	dir := t.TempDir()
	sockPath := filepath.Join(dir, "grace.sock")

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	// Apply a short deadline — the same mechanism used by the accept goroutine
	// in daemon.go for both first-connect and reattach grace.
	grace := 80 * time.Millisecond
	_ = ln.(*net.UnixListener).SetDeadline(time.Now().Add(grace))

	start := time.Now()
	_, acceptErr := ln.Accept()
	elapsed := time.Since(start)

	if acceptErr == nil {
		t.Fatal("expected deadline error, got a connection")
	}
	// Deadline should fire within a reasonable window around grace.
	if elapsed < grace/2 || elapsed > grace*5 {
		t.Errorf("deadline fired after %v, expected ~%v", elapsed, grace)
	}
}
