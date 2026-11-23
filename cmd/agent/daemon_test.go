//go:build !windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/nexus-code/nexus-code/internal/agentrun"
	"github.com/nexus-code/nexus-code/internal/proto"
	"github.com/nexus-code/nexus-code/internal/pty"
)

func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nxdh-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

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

func waitForSocket(t *testing.T, runDir, root string) string {
	t.Helper()
	id := agentrun.WsID(root, proto.ServerVersion)
	logPath := filepath.Join(runDir, id+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatalf("open daemon log %s: %v", logPath, err)
	}
	if err := logFile.Close(); err != nil {
		t.Fatalf("close daemon log %s: %v", logPath, err)
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("watch daemon log: %v", err)
	}
	defer watcher.Close()
	if err := watcher.Add(logPath); err != nil {
		t.Fatalf("watch daemon log %s: %v", logPath, err)
	}

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		data, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read daemon log %s: %v", logPath, err)
		}
		if strings.Contains(string(data), `"msg":"`+daemonListeningMessage+`"`) {
			return filepath.Join(runDir, id+".sock")
		}

		select {
		case <-watcher.Events:
		case err := <-watcher.Errors:
			t.Fatalf("daemon log watcher: %v", err)
		case <-deadline.C:
			t.Fatalf("daemon did not announce its listener within 5 s:\n%s", data)
		}
	}
}

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

func TestDaemonTakeover(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	sockPath := waitForSocket(t, runDir, root)

	connA, lineA := readReady(t, sockPath)
	defer connA.Close()
	var frameA map[string]any
	if err := json.Unmarshal([]byte(lineA), &frameA); err != nil {
		t.Fatalf("parse A ready: %v", err)
	}
	if frameA["type"] != "ready" {
		t.Fatalf("A: want ready, got %s", lineA)
	}

	connB, lineB := readReady(t, sockPath)
	defer connB.Close()
	var frameB map[string]any
	if err := json.Unmarshal([]byte(lineB), &frameB); err != nil {
		t.Fatalf("parse B ready: %v", err)
	}
	if frameB["type"] != "ready" {
		t.Fatalf("B: want ready, got %s", lineB)
	}

	if frameA["agentEpoch"] != frameB["agentEpoch"] {
		t.Errorf("epoch mismatch A=%v B=%v — different daemon instances", frameA["agentEpoch"], frameB["agentEpoch"])
	}

	_ = connA.SetReadDeadline(time.Now().Add(2 * time.Second))
	rest, err := io.ReadAll(connA)
	if errors.Is(err, os.ErrDeadlineExceeded) {
		t.Error("dialer A conn still open after takeover — expected EOF or read error")
	}
	if !strings.Contains(string(rest), `"event":"`+preemptedEvent+`"`) {
		t.Errorf("dialer A was not told it was taken over: %q", rest)
	}
}

func TestDaemonLongSessionThenReattach(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	sockPath := waitForSocket(t, runDir, root)

	connA, lineA := readReady(t, sockPath)
	var frameA map[string]any
	if err := json.Unmarshal([]byte(lineA), &frameA); err != nil {
		t.Fatalf("parse A ready: %v", err)
	}
	if frameA["type"] != "ready" {
		t.Fatalf("A: not a ready frame: %s", lineA)
	}

	_ = connA.Close()

	connB, lineB := readReady(t, sockPath)
	defer connB.Close()

	var frameB map[string]any
	if err := json.Unmarshal([]byte(lineB), &frameB); err != nil {
		t.Fatalf("parse B ready: %v", err)
	}
	if frameB["type"] != "ready" {
		t.Fatalf("B: expected ready after reattach, got: %s", lineB)
	}
	if frameA["agentEpoch"] != frameB["agentEpoch"] {
		t.Errorf("epoch mismatch: A=%v B=%v — daemon was replaced, not reattached",
			frameA["agentEpoch"], frameB["agentEpoch"])
	}
}

func TestDaemonTakeoverResumesPausedPTY(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, runDir := startDaemon(t, agentBinary(t), root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	a, nextA := connectPTYDialer(t, sockPath)
	spawnOn(t, a, "tab", root, `stty -echo; head -c 150000 /dev/zero | tr '\0' a; read -r go; printf '\nEND-MARKER\n'; read -r stop`)
	for received := 0; received < pty.HighWatermarkBytes; {
		if f := nextA(); f.Event == pty.EventData {
			received += len(f.ptyChunk(t))
		}
	}

	b, nextB := connectPTYDialer(t, sockPath)
	sendDaemonRequest(t, b, "write", "pty.write", `{"workspaceId":"ws","tabId":"tab","data":"go\n"}`)
	const marker = "\r\nEND-MARKER\r\n"
	var live strings.Builder
	for !strings.HasSuffix(live.String(), marker) {
		if f := nextB(); f.Event == pty.EventData && !f.Payload.Replay {
			live.Write(f.ptyChunk(t))
		}
	}

	ackDaemonPTY(t, b, "live-ack", live.Len())
	sendDaemonRequest(t, b, "replay", "pty.replay", `{"workspaceId":"ws","tabId":"tab"}`)
	var replay strings.Builder
	for f := nextB(); f.ID != "replay"; f = nextB() {
		if f.Event == pty.EventData && f.Payload.Replay {
			chunk := f.ptyChunk(t)
			replay.Write(chunk)
			ackDaemonPTY(t, b, "replay-ack", len(chunk))
		}
	}
	if want := "\x1bc" + strings.Repeat("a", 150_000) + marker; replay.String() != want {
		t.Fatalf("replacement replay did not match the full output (%d bytes, want %d)", replay.Len(), len(want))
	}
}

type daemonPTYFrame struct {
	proto.Response
	Type    string          `json:"type"`
	Event   string          `json:"event"`
	Payload pty.DataPayload `json:"payload"`
}

func (f daemonPTYFrame) ptyChunk(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(f.Payload.Chunk)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func connectPTYDialer(t *testing.T, sockPath string) (net.Conn, func() daemonPTYFrame) {
	t.Helper()
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	decoder := json.NewDecoder(conn)
	next := func() daemonPTYFrame {
		t.Helper()
		var f daemonPTYFrame
		if err := decoder.Decode(&f); err != nil {
			t.Fatalf("read dialer frame: %v", err)
		}
		if f.Error != nil {
			t.Fatalf("request %s failed: %+v", f.ID, f.Error)
		}
		return f
	}
	if f := next(); f.Type != "ready" {
		t.Fatalf("first frame type = %q, want ready", f.Type)
	}
	return conn, next
}

func sendDaemonRequest(t *testing.T, conn net.Conn, id, method, params string) {
	t.Helper()
	if err := json.NewEncoder(conn).Encode(proto.Request{ID: id, Method: method, Params: json.RawMessage(params)}); err != nil {
		t.Fatalf("send %s: %v", method, err)
	}
}

func ackDaemonPTY(t *testing.T, conn net.Conn, id string, count int) {
	t.Helper()
	sendDaemonRequest(t, conn, id, "pty.ack", fmt.Sprintf(`{"workspaceId":"ws","tabId":"tab","bytesConsumed":%d}`, count))
}

func TestDaemonTakeoverCancelsCreditBlockedReplay(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, runDir := startDaemon(t, agentBinary(t), root, shortHome(t))
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	sockPath := waitForSocket(t, runDir, root)

	a, nextA := connectPTYDialer(t, sockPath)
	spawnOn(t, a, "tab", root, `stty -echo; head -c 120000 /dev/zero | tr '\0' a; printf '\nHISTORY-END\n'; read -r stop`)
	var history strings.Builder
	credited := 0
	for replies := 0; replies < 2; {
		f := nextA()
		if f.ID == "first-ack" || f.ID == "last-ack" {
			replies++
		}
		if f.Event != pty.EventData {
			continue
		}
		history.Write(f.ptyChunk(t))
		if credited == 0 && history.Len() >= pty.HighWatermarkBytes {
			credited = history.Len()
			ackDaemonPTY(t, a, "first-ack", credited)
		}
		if strings.HasSuffix(history.String(), "HISTORY-END\r\n") {
			ackDaemonPTY(t, a, "last-ack", history.Len()-credited)
		}
	}

	const tab = `{"workspaceId":"ws","tabId":"tab"}`
	sendDaemonRequest(t, a, "old-replay", "pty.replay", tab)
	for received := 0; received < pty.HighWatermarkBytes; {
		f := nextA()
		if f.ID == "old-replay" {
			t.Fatal("old replay finished without credit")
		}
		if f.Event == pty.EventData && f.Payload.Replay {
			received += len(f.ptyChunk(t))
		}
	}

	b, nextB := connectPTYDialer(t, sockPath)
	sendDaemonRequest(t, b, "new-replay", "pty.replay", tab)
	var replay strings.Builder
	for f := nextB(); f.ID != "new-replay"; f = nextB() {
		if f.Event == pty.EventData && f.Payload.Replay {
			data := f.ptyChunk(t)
			replay.Write(data)
			ackDaemonPTY(t, b, "ack", len(data))
		}
	}
	if want := "\x1bc" + history.String(); replay.String() != want {
		t.Fatalf("replacement replay received %d bytes, want exactly %d bytes starting with terminal reset", replay.Len(), len(want))
	}
}

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
	conn, ready := readReady(t, waitForSocket(t, runDir, root))
	defer conn.Close()
	if !strings.Contains(ready, `"ready"`) {
		t.Fatalf("want ready frame, got %s", ready)
	}
}

func TestDaemonExitsOnShutdown(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	root := t.TempDir()
	fakeHome := shortHome(t)

	cmd, runDir := startDaemon(t, bin, root, fakeHome)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() { _ = cmd.Process.Kill() }()
	sockPath := waitForSocket(t, runDir, root)

	conn, _ := readReady(t, sockPath)
	defer conn.Close()
	if _, err := conn.Write([]byte(`{"id":"bye","method":"agent.shutdown"}` + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	sc := bufio.NewScanner(conn)
	for {
		if !sc.Scan() {
			t.Fatalf("no reply to agent.shutdown: %v", sc.Err())
		}
		var frame struct {
			ID    string          `json:"id"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &frame) == nil && frame.ID == "bye" {
			if len(frame.Error) > 0 {
				t.Fatalf("agent.shutdown failed: %s", sc.Text())
			}
			break
		}
	}

	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Errorf("old daemon socket is still present after shutdown reply: %v", err)
	}

	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("daemon exited with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon still running 5 s after agent.shutdown")
	}
	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Errorf("socket left behind: %v", err)
	}
}

func callOn(t *testing.T, conn net.Conn, id, method, params string) (json.RawMessage, json.RawMessage) {
	t.Helper()
	line := `{"id":"` + id + `","method":"` + method + `"`
	if params != "" {
		line += `,"params":` + params
	}
	if _, err := conn.Write([]byte(line + "}\n")); err != nil {
		t.Fatalf("write %s: %v", method, err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		var frame struct {
			ID     string          `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &frame) == nil && frame.ID == id {
			return frame.Result, frame.Error
		}
	}
	t.Fatalf("no reply to %s: %v", method, sc.Err())
	return nil, nil
}

func TestDaemonStopsAnotherDaemon(t *testing.T) {
	t.Parallel()
	bin := agentBinary(t)
	fakeHome := shortHome(t)
	rootA := t.TempDir()
	rootB := t.TempDir()

	cmdA, runDir := startDaemon(t, bin, rootA, fakeHome)
	defer func() { _ = cmdA.Process.Kill(); _ = cmdA.Wait() }()
	cmdB, _ := startDaemon(t, bin, rootB, fakeHome)
	exitedB := make(chan error, 1)
	go func() { exitedB <- cmdB.Wait() }()
	defer func() { _ = cmdB.Process.Kill() }()

	sockA := waitForSocket(t, runDir, rootA)
	waitForSocket(t, runDir, rootB)

	conn, _ := readReady(t, sockA)
	defer conn.Close()

	params, _ := json.Marshal(map[string]string{"root": rootB})
	result, callErr := callOn(t, conn, "stop-b", "agent.stopDaemon", string(params))
	if len(callErr) > 0 && string(callErr) != "null" {
		t.Fatalf("agent.stopDaemon failed: %s", callErr)
	}
	if string(result) != `{"stopped":true}` {
		t.Fatalf("agent.stopDaemon result = %s, want stopped", result)
	}
	select {
	case err := <-exitedB:
		if err != nil {
			t.Fatalf("daemon B exited with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon B still running 5 s after agent.stopDaemon")
	}

	result, callErr = callOn(t, conn, "stop-b-again", "agent.stopDaemon", string(params))
	if len(callErr) > 0 && string(callErr) != "null" {
		t.Fatalf("agent.stopDaemon without a daemon failed: %s", callErr)
	}
	if string(result) != `{"stopped":false}` {
		t.Fatalf("agent.stopDaemon without a daemon = %s, want not stopped", result)
	}

	own, _ := json.Marshal(map[string]string{"root": rootA})
	if _, callErr = callOn(t, conn, "stop-a", "agent.stopDaemon", string(own)); len(callErr) == 0 {
		t.Fatal("agent.stopDaemon stopped the daemon's own root")
	}
	if _, callErr = callOn(t, conn, "ping", "ping", ""); len(callErr) > 0 && string(callErr) != "null" {
		t.Fatalf("daemon A no longer answers: %s", callErr)
	}
}
