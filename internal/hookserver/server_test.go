package hookserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

type handshakingConn struct {
	net.Conn
	reading chan struct{}
	started sync.Once
}

func (c *handshakingConn) Read(p []byte) (int, error) {
	c.started.Do(func() { close(c.reading) })
	return c.Conn.Read(p)
}

func TestCloseReleasesIncompleteRequests(t *testing.T) {
	srv := newTestServer(t, nil)
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	conn := &handshakingConn{Conn: server, reading: make(chan struct{})}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		srv.handleConn(conn)
	}()
	select {
	case <-conn.reading:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not begin reading")
	}
	if err := srv.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("the incomplete request is still waiting after Close")
	}
}

func TestMain(m *testing.M) {
	parent := "/tmp"
	if runtime.GOOS == "windows" {
		parent = ""
	}
	home, err := os.MkdirTemp(parent, "hs-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

func newTestServer(t *testing.T, sink EventSink) *Server {
	t.Helper()
	key := fmt.Sprintf("test-%d", os.Getpid())
	srv, err := New(key, sink)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

func TestAnsweredRequestsStopDeadlineTimers(t *testing.T) {
	for _, kind := range []string{"hook", "cli"} {
		t.Run(kind, func(t *testing.T) {
			ids := make(chan string, 1)
			armed, stopped := make(chan struct{}), make(chan struct{})
			srv, err := newServer(fmt.Sprintf("timer-%d", os.Getpid()), func(_ string, payload any) error {
				switch event := payload.(type) {
				case HookEventPayload:
					ids <- event.HookID
				case CLIEventPayload:
					ids <- event.RequestID
				}
				return nil
			}, func(time.Duration) (<-chan time.Time, func()) {
				close(armed)
				return nil, func() { close(stopped) }
			})
			if err != nil {
				t.Fatal(err)
			}
			defer srv.Close()
			req := cliRequest(srv.Token())
			req.Type = kind
			req.Subcommand = "permission-request"
			conn := dialAndSendRequest(t, srv.SocketPath(), req)
			defer conn.Close()
			var id string
			select {
			case id = <-ids:
			case <-time.After(2 * time.Second):
				t.Fatal("request event did not arrive")
			}
			select {
			case <-armed:
			case <-time.After(2 * time.Second):
				t.Fatal("request deadline was never armed")
			}
			if kind == "cli" {
				err = srv.RespondCLI(id, json.RawMessage("null"))
			} else {
				err = srv.Respond(id, HookResponse{})
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("answered request left its deadline running")
			}
		})
	}
}

func dialAndSendRequest(t *testing.T, socketPath string, req hookWireRequest) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		t.Fatalf("write: %v", err)
	}
	return conn
}

func readResponse(t *testing.T, conn net.Conn, timeout time.Duration) hookWireResponse {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatalf("readResponse: scan failed: %v", scanner.Err())
	}
	var resp hookWireResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("readResponse: unmarshal: %v", err)
	}
	return resp
}

func TestNew_ListenAndPerm(t *testing.T) {
	var sinkCalled int32
	srv := newTestServer(t, func(_ string, _ any) error {
		atomic.AddInt32(&sinkCalled, 1)
		return nil
	})

	info, err := os.Stat(srv.SocketPath())
	if err != nil {
		t.Fatalf("socket file not found: %v", err)
	}

	perm := info.Mode().Perm()
	if runtime.GOOS != "windows" && perm != 0600 {
		t.Errorf("socket perm: want 0600, got %04o", perm)
	}

	if srv.Token() == "" {
		t.Error("token is empty")
	}
}

const socketSuffixLen = len(`/sockets/h-0123456789ab.sock`)

func pathOfLength(t *testing.T, base string, n int) string {
	t.Helper()
	pad := n - len(base) - 1
	if pad < 1 {
		t.Fatalf("%s is too long to make a %d-byte path", base, n)
	}
	return filepath.Join(base, strings.Repeat("h", pad))
}

func newServerWithCleanup(t *testing.T, key string) *Server {
	t.Helper()
	srv, err := New(key, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		_ = srv.Close()
		if runtime.GOOS != "windows" {
			_ = os.Remove(filepath.Dir(srv.SocketPath()))
		}
	})
	return srv
}

func dialOnce(t *testing.T, socket string) {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatalf("dial %s: %v", socket, err)
	}
	_ = conn.Close()
}

func TestNew_SocketAtTheLimitStaysUnderTheHome(t *testing.T) {
	home := pathOfLength(t, shortTempDir(t), agentpaths.MaxSocketPathLen()-socketSuffixLen)
	t.Setenv(agentpaths.HomeEnv, home)

	srv := newServerWithCleanup(t, "limit")
	if got := srv.SocketPath(); len(got) != agentpaths.MaxSocketPathLen() || !strings.HasPrefix(got, home) {
		t.Fatalf("socket = %s (%d bytes), want %d bytes under %s", got, len(got), agentpaths.MaxSocketPathLen(), home)
	}
	dialOnce(t, srv.SocketPath())
}

func TestNew_LongHomeFallsBackToAPrivateDirectory(t *testing.T) {
	home := pathOfLength(t, shortTempDir(t), agentpaths.MaxSocketPathLen()-socketSuffixLen+1)
	t.Setenv(agentpaths.HomeEnv, home)

	srv := newServerWithCleanup(t, "fallback")
	dir := filepath.Dir(srv.SocketPath())
	if strings.HasPrefix(dir, home) || !agentpaths.SocketPathFits(srv.SocketPath()) {
		t.Fatalf("socket = %s, want a short path outside %s", srv.SocketPath(), home)
	}
	if runtime.GOOS == "windows" {
		parent := filepath.Join(os.Getenv("USERPROFILE"), ".nexus-code", "s")
		if filepath.Dir(dir) != parent || len(filepath.Base(dir)) != 16 {
			t.Fatalf("fallback directory = %s, want a hashed directory in %s", dir, parent)
		}
	} else {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(dir, "/tmp/nexus-code-") || info.Mode().Perm() != 0o700 {
			t.Fatalf("fallback directory = %s (%04o), want a 0700 directory under /tmp", dir, info.Mode().Perm())
		}
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("New created the long home %s", home)
	}
	dialOnce(t, srv.SocketPath())
}

func TestNew_RefusesWhenTheFallbackIsTooLong(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("macOS and Linux fall back under /tmp, which always fits")
	}
	base := shortTempDir(t)
	longProfile := pathOfLength(t, base, agentpaths.MaxSocketPathLen())
	for name, named := range map[string]string{
		"default home":    "",
		"named long home": pathOfLength(t, filepath.Join(base, "named"), agentpaths.MaxSocketPathLen()),
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("USERPROFILE", longProfile)
			t.Setenv(agentpaths.HomeEnv, named)

			srv, err := New("long", nil)
			if err == nil {
				_ = srv.Close()
				t.Fatal("New succeeded although the socket and its fallback are over the limit")
			}
			var pathErr *agentpaths.SocketPathError
			if !errors.As(err, &pathErr) {
				t.Fatalf("New error = %v, want a SocketPathError", err)
			}
			if named != "" && !strings.Contains(err.Error(), named) {
				t.Errorf("New error = %q, want it to name %s", err, named)
			}
			for _, dir := range []string{longProfile, named} {
				if dir == "" {
					continue
				}
				if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
					t.Errorf("New created %s although it refused the path", dir)
				}
			}
		})
	}
}

func TestNew_FallbackLeavesTheDefaultSocketsDirectoryAlone(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows falls back under the user profile")
	}
	profile := shortTempDir(t)
	t.Setenv("USERPROFILE", profile)
	t.Setenv(agentpaths.HomeEnv, pathOfLength(t, shortTempDir(t), agentpaths.MaxSocketPathLen()))
	sockets := filepath.Join(profile, ".nexus-code", "sockets")
	live := filepath.Join(sockets, "h-0123456789ab.sock")
	if err := os.MkdirAll(sockets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(live, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	before := map[string]string{sockets: icacls(t, sockets), live: icacls(t, live)}

	srv := newServerWithCleanup(t, "default-alone")
	if strings.HasPrefix(srv.SocketPath(), sockets) {
		t.Fatalf("socket = %s, want it outside %s", srv.SocketPath(), sockets)
	}
	for path, acl := range before {
		if got := icacls(t, path); got != acl {
			t.Errorf("ACL of %s changed from\n%s\nto\n%s", path, acl, got)
		}
	}
	if _, err := os.Stat(live); err != nil {
		t.Errorf("the default directory lost %s: %v", live, err)
	}
}

func icacls(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("icacls", path).Output()
	if err != nil {
		t.Fatalf("icacls %s: %v", path, err)
	}
	return string(out)
}

func TestNew_DoesNotListenInAFallbackDirectoryOthersCanReach(t *testing.T) {
	home := pathOfLength(t, shortTempDir(t), agentpaths.MaxSocketPathLen())
	t.Setenv(agentpaths.HomeEnv, home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", shortTempDir(t))
	}
	_, fallback, private, err := makeSocketPath("reach")
	if err != nil || !private {
		t.Fatalf("makeSocketPath: private=%v err=%v", private, err)
	}

	target := shortTempDir(t)
	if runtime.GOOS == "windows" {
		if err := os.MkdirAll(filepath.Dir(fallback), 0o700); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", fallback, target).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J: %v %s", err, out)
		}
		t.Cleanup(func() { _ = os.Remove(fallback) })
		if srv, err := New("reach", nil); err == nil {
			_ = srv.Close()
			t.Fatalf("New listened through the junction %s", fallback)
		}
		return
	}

	if err := os.Symlink(target, fallback); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(fallback) })
	listensElsewhere(t, fallback)
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("New left %d entries behind the link in %s", len(entries), target)
	}

	if err := os.Remove(fallback); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(fallback, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(fallback) })
	if err := os.Chmod(fallback, 0o755); err != nil {
		t.Fatal(err)
	}
	listensElsewhere(t, fallback)
	if info, err := os.Lstat(fallback); err != nil || !info.IsDir() || info.Mode().Perm() != 0o755 {
		t.Fatalf("the refused directory %s is gone or changed: %v", fallback, err)
	}
}

func listensElsewhere(t *testing.T, refused string) {
	t.Helper()
	srv := newServerWithCleanup(t, "reach")
	dir := filepath.Dir(srv.SocketPath())
	prefix := fmt.Sprintf("/tmp/nexus-code-%d-", os.Getuid())
	if dir == refused || !strings.HasPrefix(dir, prefix) {
		t.Fatalf("socket directory = %s, want a fresh %s* directory", dir, prefix)
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("socket directory %s is not a 0700 directory: %v", dir, err)
	}
	dialOnce(t, srv.SocketPath())
	if err := srv.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("Close left the fresh directory %s: %v", dir, err)
	}
}

func TestHandleConn_LargePayload(t *testing.T) {
	calls := make(chan HookEventPayload, 1)
	srv := newTestServer(t, func(_ string, payload any) error {
		if p, ok := payload.(HookEventPayload); ok {
			calls <- p
		}
		return nil
	})

	content := strings.Repeat("x", 4<<20)
	payload, _ := json.Marshal(map[string]any{
		"tool_name":  "Write",
		"tool_input": map[string]any{"file_path": "/tmp/big.txt", "content": content},
	})
	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-big",
		TabID:       "tab-big",
		Subcommand:  "permission-request",
		Payload:     payload,
	})
	defer conn.Close()

	select {
	case call := <-calls:
		if len(call.Payload) != len(payload) {
			t.Fatalf("payload length: want %d, got %d", len(payload), len(call.Payload))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("large hook payload produced no event")
	}
}

func TestHandleConn_OversizedRequestFallsBack(t *testing.T) {
	srv := newTestServer(t, func(_ string, _ any) error {
		t.Error("sink must not be called for an oversized request")
		return nil
	})

	conn, err := net.Dial("unix", srv.SocketPath())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	go func() {
		_, _ = conn.Write([]byte(`{"type":"hook","payload":"` + strings.Repeat("x", maxRequestBytes) + `"}` + "\n"))
	}()

	resp := readResponse(t, conn, 5*time.Second)
	if !resp.OK || resp.ExitCode != nil || resp.Stdout != "" {
		t.Fatalf("want bare ok response, got %+v", resp)
	}
}

func TestHandleConn_TokenMismatch(t *testing.T) {
	srv := newTestServer(t, func(_ string, _ any) error { return nil })

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       "wrong-token",
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "session-start",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	_, err := conn.Read(buf)
	if err == nil {
		t.Error("expected connection to be closed by server on token mismatch, but read succeeded")
	}
}

func TestRespond_WritesAndDeletesInflight(t *testing.T) {
	type sinkCall struct {
		hookID string
	}
	hookIDCh := make(chan string, 1)

	srv := newTestServer(t, func(_ string, payload any) error {
		if p, ok := payload.(HookEventPayload); ok {
			hookIDCh <- p.HookID
		}
		return nil
	})

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "notification",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	var hookID string
	select {
	case hookID = <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId from sink")
	}

	_, ok := srv.inflight.Load(hookID)
	if !ok {
		t.Fatalf("hookId %q not in inflight map before Respond()", hookID)
	}

	exitVal := 0
	if err := srv.Respond(hookID, HookResponse{Stdout: "hello", ExitCode: &exitVal}); err != nil {
		t.Fatalf("Respond: %v", err)
	}

	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("response ok: want true, got false")
	}
	if resp.Stdout != "hello" {
		t.Errorf("response stdout: want 'hello', got %q", resp.Stdout)
	}

	_, stillExists := srv.inflight.Load(hookID)
	if stillExists {
		t.Error("hookId still in inflight map after Respond()")
	}
}

func TestDeadline_DefaultResponse(t *testing.T) {
	hookIDCh := make(chan string, 1)

	srv := newTestServer(t, func(_ string, payload any) error {
		if p, ok := payload.(HookEventPayload); ok {
			hookIDCh <- p.HookID
		}
		return nil
	})
	srv.testDeadlineNs.Store(int64(100 * time.Millisecond))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	var hookID string
	select {
	case hookID = <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId")
	}

	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("default response ok: want true, got false")
	}
	if resp.Stdout != "" {
		t.Errorf("default response stdout: want empty, got %q", resp.Stdout)
	}

	_, stillExists := srv.inflight.Load(hookID)
	if stillExists {
		t.Error("hookId still in inflight map after deadline timeout")
	}
}

func TestUndeliveredHook_DefaultResponseAtOnce(t *testing.T) {
	srv := newTestServer(t, func(string, any) error {
		return fmt.Errorf("write: broken pipe")
	})
	srv.testDeadlineNs.Store(int64(time.Minute))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK || resp.Stdout != "" {
		t.Errorf("response: want ok with no stdout, got %+v", resp)
	}
	empty := true
	srv.inflight.Range(func(any, any) bool {
		empty = false
		return false
	})
	if !empty {
		t.Error("an undelivered hook is still in flight")
	}
}

func TestReleaseHooks_AnswersWaitingHooks(t *testing.T) {
	heard := make(chan struct{}, 1)
	srv := newTestServer(t, func(string, any) error {
		heard <- struct{}{}
		return nil
	})
	srv.testDeadlineNs.Store(int64(time.Minute))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()
	select {
	case <-heard:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the hook")
	}

	srv.ReleaseHooks()
	if resp := readResponse(t, conn, 2*time.Second); !resp.OK || resp.Stdout != "" {
		t.Errorf("response: want ok with no stdout, got %+v", resp)
	}
}

func TestHookGone_ToldWhenClientLeaves(t *testing.T) {
	heard := make(chan HookEventPayload, 1)
	gone := make(chan HookGonePayload, 1)
	srv := newTestServer(t, func(event string, payload any) error {
		switch p := payload.(type) {
		case HookEventPayload:
			heard <- p
		case HookGonePayload:
			if event != "claude.hookGone" {
				t.Errorf("event: want claude.hookGone, got %q", event)
			}
			gone <- p
		}
		return nil
	})
	srv.testDeadlineNs.Store(int64(time.Minute))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
		Print:       true,
	})
	var hook HookEventPayload
	select {
	case hook = <-heard:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the hook")
	}
	if !hook.Print {
		t.Error("print: want true, got false")
	}
	conn.Close()

	select {
	case p := <-gone:
		if p.HookID != hook.HookID || p.WorkspaceID != "ws-1" || p.TabID != "tab-1" {
			t.Errorf("gone: want %s ws-1 tab-1, got %+v", hook.HookID, p)
		}
		if p.Subcommand != "permission-request" || p.Payload != nil {
			t.Errorf("gone: want the subcommand with no payload, got %+v", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for claude.hookGone")
	}
	if _, waiting := srv.inflight.Load(hook.HookID); waiting {
		t.Error("a hook whose client left is still in flight")
	}
	if err := srv.Respond(hook.HookID, HookResponse{}); err == nil {
		t.Error("Respond to a gone hook: want an error, got none")
	}
}

func TestPrintWatch_HeldUntilItsClientGoes(t *testing.T) {
	heard := make(chan HookEventPayload, 1)
	gone := make(chan HookGonePayload, 1)
	srv := newTestServer(t, func(_ string, payload any) error {
		switch p := payload.(type) {
		case HookEventPayload:
			heard <- p
		case HookGonePayload:
			gone <- p
		}
		return nil
	})
	srv.testDeadlineNs.Store(int64(50 * time.Millisecond))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "print-watch",
		Payload:     json.RawMessage(`{"run_id":"print-1"}`),
	})
	var hook HookEventPayload
	select {
	case hook = <-heard:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the watch")
	}
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, err := conn.Read(make([]byte, 1)); n > 0 || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read: want a timeout, got %d bytes, %v", n, err)
	}
	if _, waiting := srv.inflight.Load(hook.HookID); !waiting {
		t.Fatal("the watch is no longer held")
	}
	conn.Close()

	select {
	case p := <-gone:
		if p.HookID != hook.HookID || p.Subcommand != "print-watch" || string(p.Payload) != `{"run_id":"print-1"}` {
			t.Errorf("gone: got %+v", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for claude.hookGone")
	}
}

func TestHookGone_NotToldOnceAnswered(t *testing.T) {
	heard := make(chan string, 1)
	gone := make(chan struct{}, 1)
	srv := newTestServer(t, func(_ string, payload any) error {
		switch p := payload.(type) {
		case HookEventPayload:
			heard <- p.HookID
		case HookGonePayload:
			gone <- struct{}{}
		}
		return nil
	})
	srv.testDeadlineNs.Store(int64(time.Minute))

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "permission-request",
		Payload:     json.RawMessage(`{}`),
	})
	var hookID string
	select {
	case hookID = <-heard:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the hook")
	}
	if err := srv.Respond(hookID, HookResponse{Stdout: "{}"}); err != nil {
		t.Fatalf("Respond: %v", err)
	}
	if resp := readResponse(t, conn, 2*time.Second); resp.Stdout != "{}" {
		t.Errorf("stdout: want {}, got %q", resp.Stdout)
	}
	conn.Close()
	select {
	case <-gone:
		t.Error("an answered hook was told gone")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestClose_CleanupAll(t *testing.T) {
	hookIDCh := make(chan string, 1)

	key := fmt.Sprintf("close-test-%d", os.Getpid())
	srv, err := New(key, func(_ string, payload any) error {
		if p, ok := payload.(HookEventPayload); ok {
			hookIDCh <- p.HookID
		}
		return nil
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	conn := dialAndSendRequest(t, srv.SocketPath(), hookWireRequest{
		Type:        "hook",
		Token:       srv.Token(),
		WorkspaceID: "ws-1",
		TabID:       "tab-1",
		Subcommand:  "session-start",
		Payload:     json.RawMessage(`{}`),
	})
	defer conn.Close()

	select {
	case <-hookIDCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hookId")
	}

	socketPath := srv.SocketPath()

	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	resp := readResponse(t, conn, 2*time.Second)
	if !resp.OK {
		t.Errorf("close cleanup response ok: want true, got false")
	}

	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Errorf("socket file still exists after Close()")
	}

	_, dialErr := net.Dial("unix", socketPath)
	if dialErr == nil {
		t.Error("expected dial to fail after Close(), but it succeeded")
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	parent := "/tmp"
	if runtime.GOOS == "windows" {
		parent = ""
	}
	dir, err := os.MkdirTemp(parent, "hs-test-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func staleNow() time.Time {
	return time.Now().Add(70 * time.Second)
}

func makeDeadSocket(t *testing.T, path string) {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("Socket: %v", err)
	}
	addr := syscall.SockaddrUnix{Name: path}
	if err := syscall.Bind(fd, &addr); err != nil {
		syscall.Close(fd)
		t.Fatalf("Bind %q: %v", path, err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		os.Remove(path)
	})
}

func Test_cleanStaleSockets_AlivePreserved(t *testing.T) {
	dir := shortTempDir(t)

	sockPath := filepath.Join(dir, "h-aabbccdd0011.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	cleanStaleSockets(dir, "other-self.sock", staleNow())

	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("alive socket was incorrectly removed by cleanStaleSockets")
	}

	conn, err := net.DialTimeout("unix", sockPath, time.Second)
	if err != nil {
		t.Errorf("listener no longer reachable after cleanStaleSockets: %v", err)
	} else {
		conn.Close()
	}
}

func Test_cleanStaleSockets_DeadOldRemoved(t *testing.T) {
	dir := shortTempDir(t)

	sockPath := filepath.Join(dir, "h-deadbeef0001.sock")
	makeDeadSocket(t, sockPath)

	cleanStaleSockets(dir, "other-self.sock", staleNow())

	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Error("dead+old socket was NOT removed by cleanStaleSockets")
	}
}

func Test_cleanStaleSockets_DeadFreshPreserved(t *testing.T) {
	dir := shortTempDir(t)

	sockPath := filepath.Join(dir, "h-freshbeef0002.sock")
	makeDeadSocket(t, sockPath)

	cleanStaleSockets(dir, "other-self.sock", time.Now())

	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("fresh dead socket was incorrectly removed by cleanStaleSockets (should be preserved)")
	}
}

func Test_cleanStaleSockets_SelfPreserved(t *testing.T) {
	dir := shortTempDir(t)

	selfName := "h-selffile0011.sock"
	sockPath := filepath.Join(dir, selfName)

	makeDeadSocket(t, sockPath)

	cleanStaleSockets(dir, selfName, staleNow())

	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Error("self socket was incorrectly removed by cleanStaleSockets")
	}
}
