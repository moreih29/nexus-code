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

func TestRunSendsStdinForKeyFile(t *testing.T) {
	for _, command := range [][]string{{"chat", "profiles", "add"}, {"chat", "profiles", "edit", "Gateway"}} {
		for _, flags := range [][]string{{"--key-file", "-"}, {"--key-file=-"}} {
			t.Run(strings.Join(append(append([]string{}, command...), flags...), " "), func(t *testing.T) {
				answer, _ := json.Marshal(wireResponse{OK: true, Result: &result{}})
				socket, asked := fakeApp(t, string(answer))
				setTerminalEnv(t, socket)
				args := append(append([]string{}, command...), flags...)
				var stdout, stderr bytes.Buffer
				if code := run(args, strings.NewReader("test-key\n"), &stdout, &stderr); code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
					t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
				}
				req := <-asked
				if req.Payload.Stdin == nil || *req.Payload.Stdin != "test-key\n" {
					t.Fatal("request did not receive the key through stdin")
				}
			})
		}
	}
}

func TestRunReadsNoStdinForAKeyFileFlagElsewhere(t *testing.T) {
	answer, _ := json.Marshal(wireResponse{OK: true, Result: &result{}})
	socket, asked := fakeApp(t, string(answer))
	setTerminalEnv(t, socket)
	var stdout, stderr bytes.Buffer
	args := []string{"chat", "profiles", "remove", "Gateway", "--key-file=-"}
	if code := run(args, strings.NewReader("test-key\n"), &stdout, &stderr); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr.String())
	}
	if req := <-asked; req.Payload.Stdin != nil {
		t.Fatal("a command without a key file read stdin")
	}
}

func TestRunSendsGitBashsRoot(t *testing.T) {
	for _, tc := range []struct {
		name string
		root *string
	}{
		{"git bash", ptr(`C:\Program Files\Git\`)},
		{"git bash without cygpath", ptr("")},
		{"another shell", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			answer, _ := json.Marshal(wireResponse{OK: true, Result: &result{}})
			socket, asked := fakeApp(t, string(answer))
			setTerminalEnv(t, socket)
			if tc.root != nil {
				t.Setenv(envMsysRoot, *tc.root)
			} else {
				unsetEnv(t, envMsysRoot)
			}

			var stdout, stderr bytes.Buffer
			if code := run([]string{"status"}, strings.NewReader(""), &stdout, &stderr); code != 0 {
				t.Fatalf("code = %d, stderr = %q", code, stderr.String())
			}
			got := (<-asked).Payload.MsysRoot
			if (got == nil) != (tc.root == nil) || (got != nil && *got != *tc.root) {
				t.Fatalf("msysRoot = %v, want %v", got, tc.root)
			}
		})
	}
}

func ptr(s string) *string { return &s }

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	t.Setenv(key, "")
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
}

type countingReader struct {
	strings.Reader
	read int
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.read += n
	return n, err
}

func TestRunOutsideTheAppSkipsAgentContextQuietly(t *testing.T) {
	for _, name := range []string{envAgentSocket, envHookToken, envWorkspaceID, envTabID} {
		t.Run(name, func(t *testing.T) {
			setTerminalEnv(t, filepath.Join(t.TempDir(), "s.sock"))
			unsetEnv(t, name)
			hookInput := `{"hook_event_name":"UserPromptSubmit","prompt":"hi"}`
			stdin := &countingReader{Reader: *strings.NewReader(hookInput)}
			var stdout, stderr bytes.Buffer
			code := run([]string{"agent-context", "--launch=l", "-"}, stdin, &stdout, &stderr)
			if code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			if stdin.read != len(hookInput) {
				t.Fatalf("read %d of %d stdin bytes", stdin.read, len(hookInput))
			}
		})
	}
}

func TestRunOutsideTheAppKeepsTheUsageError(t *testing.T) {
	for _, name := range []string{envAgentSocket, envHookToken, envWorkspaceID, envTabID} {
		unsetEnv(t, name)
	}
	for _, args := range [][]string{
		{"chat", "list"},
		{"worktree", "claude-create", "-"},
		{"terminal", "send", "x", "agent-context"},
		{},
	} {
		var stdout, stderr bytes.Buffer
		code := run(args, strings.NewReader("{}"), &stdout, &stderr)
		if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "run this in a NexusCode terminal") {
			t.Fatalf("%v: code=%d stdout=%q stderr=%q", args, code, stdout.String(), stderr.String())
		}
	}
}
