//go:build !windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func launchDaemonLikeBootstrap(t *testing.T, bin, root, fakeHome string) string {
	t.Helper()
	runDir := filepath.Join(fakeHome, ".nexus-code", "run")
	if err := os.MkdirAll(runDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	launch := exec.Command("/bin/sh", "-c", `( "$0" --daemon "$1" </dev/null >/dev/null 2>&1 & )`, bin, root)
	launch.Env = append(os.Environ(), "HOME="+fakeHome)
	if out, err := launch.CombinedOutput(); err != nil {
		t.Fatalf("launch daemon: %v: %s", err, out)
	}
	return runDir
}

type ptyFrames struct {
	sc   *bufio.Scanner
	text strings.Builder
}

func newPtyFrames(conn net.Conn) *ptyFrames {
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	return &ptyFrames{sc: sc}
}

func (f *ptyFrames) until(t *testing.T, conn net.Conn, within time.Duration, done func(text string, exited bool) bool) (string, bool) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(within))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	exited := false
	for f.sc.Scan() {
		var frame struct {
			Event   string `json:"event"`
			Payload struct {
				Chunk string `json:"chunk"`
			} `json:"payload"`
		}
		if json.Unmarshal(f.sc.Bytes(), &frame) != nil {
			continue
		}
		switch frame.Event {
		case "pty.data":
			chunk, _ := base64.StdEncoding.DecodeString(frame.Payload.Chunk)
			f.text.Write(chunk)
		case "pty.exit":
			exited = true
		}
		if done(f.text.String(), exited) {
			return f.text.String(), exited
		}
	}
	return f.text.String(), exited
}

func startDaemonForSignals(t *testing.T) (net.Conn, string) {
	t.Helper()
	bin := agentBinary(t)
	root := t.TempDir()
	runDir := launchDaemonLikeBootstrap(t, bin, root, shortHome(t))
	conn, _ := readReady(t, waitForSocket(t, runDir, root))
	t.Cleanup(func() {
		_, _ = conn.Write([]byte(`{"id":"bye","method":"agent.shutdown"}` + "\n"))
		_ = conn.Close()
	})
	return conn, root
}

func spawnOn(t *testing.T, conn net.Conn, tabID, cwd, script string) {
	t.Helper()
	spawn, _ := json.Marshal(map[string]any{
		"id": "spawn-" + tabID, "method": "pty.spawn",
		"params": map[string]any{
			"workspaceId": "ws", "tabId": tabID, "cwd": cwd, "cols": 80, "rows": 24,
			"shell": "/bin/sh", "args": []string{"-c", script},
		},
	})
	if _, err := conn.Write(append(spawn, '\n')); err != nil {
		t.Fatalf("spawn: %v", err)
	}
}

func TestDaemonClosedTabEndsItsForegroundProgram(t *testing.T) {
	t.Parallel()
	conn, root := startDaemonForSignals(t)
	frames := newPtyFrames(conn)

	spawnOn(t, conn, "tui", root, `set -m; sh -c 'echo "FG=$$"; exec sleep 300'`)
	fgPattern := regexp.MustCompile(`FG=(\d+)`)
	text, _ := frames.until(t, conn, 5*time.Second, func(text string, _ bool) bool {
		return fgPattern.MatchString(text)
	})
	match := fgPattern.FindStringSubmatch(text)
	if match == nil {
		t.Fatalf("the program never started: %q", text)
	}
	pid, _ := strconv.Atoi(match[1])
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })

	if _, errFrame := callOn(t, conn, "kill", "pty.kill", `{"workspaceId":"ws","tabId":"tui"}`); len(errFrame) > 0 && string(errFrame) != "null" {
		t.Fatalf("pty.kill: %s", errFrame)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the program (pid %d) outlived its closed tab: %s", pid, signalDispositions(pid))
}

func TestDaemonChildrenStartWithDefaultSignals(t *testing.T) {
	t.Parallel()
	conn, root := startDaemonForSignals(t)
	for _, sig := range []string{"HUP", "INT"} {
		frames := newPtyFrames(conn)
		spawnOn(t, conn, "sig-"+sig, root, "kill -"+sig+" $$; echo SURVIVED-"+sig+"; sleep 30")
		text, exited := frames.until(t, conn, 5*time.Second, func(text string, exited bool) bool {
			return exited || strings.Contains(text, "SURVIVED-")
		})
		if strings.Contains(text, "SURVIVED-"+sig) {
			t.Errorf("a shell the daemon started ignored SIG%s", sig)
		} else if !exited {
			t.Errorf("SIG%s: the shell neither died nor went on: %q", sig, text)
		}
	}
}

func TestDaemonSurvivesHangupAndInterrupt(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	cmd, runDir := startDaemon(t, bin, root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)
	first, _ := readReady(t, sockPath)
	defer first.Close()

	for _, sig := range []syscall.Signal{syscall.SIGHUP, syscall.SIGINT} {
		if err := cmd.Process.Signal(sig); err != nil {
			t.Fatalf("signal %v: %v", sig, err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	next, ready := readReady(t, sockPath)
	defer next.Close()
	if !strings.Contains(ready, "agentEpoch") {
		t.Fatalf("no Ready frame after the signals: %q", ready)
	}
}

func signalDispositions(pid int) string {
	if status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid)); err == nil {
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "SigIgn:") {
				return line
			}
		}
	}
	return "its ignored signals are not readable here"
}
