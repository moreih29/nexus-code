package cliclient

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeApp answers one CLI request with `answer` and hands back what it was asked.
func fakeApp(t *testing.T, answer string) (socket string, asked <-chan wireRequest) {
	t.Helper()
	parent := "/tmp"
	if runtime.GOOS == "windows" {
		parent = ""
	}
	dir, err := os.MkdirTemp(parent, "cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket = filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	ch := make(chan wireRequest, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		scanner := bufio.NewScanner(conn)
		if !scanner.Scan() {
			return
		}
		var req wireRequest
		_ = json.Unmarshal(scanner.Bytes(), &req)
		ch <- req
		_, _ = conn.Write([]byte(answer + "\n"))
	}()
	return socket, ch
}

func setTerminalEnv(t *testing.T, socket string) {
	t.Setenv(envAgentSocket, socket)
	t.Setenv(envHookToken, "tok")
	t.Setenv(envWorkspaceID, "ws")
	t.Setenv(envTabID, "tab")
}

// The client sends its arguments and where it runs, then prints the app's
// output, writes the files it made and exits with its code.
func TestRunPrintsTheAppsAnswer(t *testing.T) {
	out := filepath.Join(t.TempDir(), "shots", "page.png")
	answer, _ := json.Marshal(wireResponse{OK: true, Result: &result{
		Stdout:   "saved " + out + "\n",
		Stderr:   "warning\n",
		ExitCode: 3,
		Files:    []file{{Path: out, Base64: base64.StdEncoding.EncodeToString([]byte("png"))}},
	}})
	socket, asked := fakeApp(t, string(answer))
	setTerminalEnv(t, socket)

	var stdout, stderr bytes.Buffer
	code := run([]string{"browser", "screenshot"}, strings.NewReader(""), &stdout, &stderr)

	if code != 3 || stdout.String() != "saved "+out+"\n" || stderr.String() != "warning\n" {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	req := <-asked
	if req.Type != "cli" || req.Token != "tok" || req.WorkspaceID != "ws" || req.TabID != "tab" {
		t.Fatalf("request = %+v", req)
	}
	if strings.Join(req.Payload.Argv, " ") != "browser screenshot" || req.Payload.Cwd == "" || req.Payload.Stdin != nil {
		t.Fatalf("payload = %+v", req.Payload)
	}
	if data, err := os.ReadFile(out); err != nil || string(data) != "png" {
		t.Fatalf("file = %q, %v", data, err)
	}
}

// A "-" argument sends standard input along.
func TestRunSendsStdinForADash(t *testing.T) {
	answer, _ := json.Marshal(wireResponse{OK: true, Result: &result{}})
	socket, asked := fakeApp(t, string(answer))
	setTerminalEnv(t, socket)

	var stdout, stderr bytes.Buffer
	if code := run([]string{"terminal", "send", "x", "-"}, strings.NewReader("line 1\nline 2\n"), &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
	req := <-asked
	if req.Payload.Stdin == nil || *req.Payload.Stdin != "line 1\nline 2\n" {
		t.Fatalf("stdin = %v", req.Payload.Stdin)
	}
}

// The app's refusal is printed as the error.
func TestRunReportsTheAppsError(t *testing.T) {
	socket, _ := fakeApp(t, `{"ok":false,"error":"NexusCode is not connected"}`)
	setTerminalEnv(t, socket)

	var stdout, stderr bytes.Buffer
	if code := run([]string{"status"}, strings.NewReader(""), &stdout, &stderr); code != 1 {
		t.Fatalf("code = %d", code)
	}
	if stderr.String() != "nexus: NexusCode is not connected\n" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

// Outside the app's terminals there is nothing to talk to.
func TestRunOutsideTheAppSaysSo(t *testing.T) {
	t.Setenv(envAgentSocket, "")
	var stdout, stderr bytes.Buffer
	if code := run([]string{"status"}, strings.NewReader(""), &stdout, &stderr); code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(stderr.String(), "NexusCode terminal") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
