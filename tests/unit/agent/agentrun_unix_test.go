//go:build darwin || linux

package agent_test

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/agentrun"
)

func socketFixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nx-agent-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestForwardingCanStartAfterDaemonBoot(t *testing.T) {
	dir := socketFixtureDir(t)
	link := filepath.Join(dir, "daemon.agent")
	t.Setenv("SSH_AUTH_SOCK", "")
	if !agentrun.AdoptAuthSock(link) || os.Getenv("SSH_AUTH_SOCK") != link {
		t.Fatal("daemon did not export its stable path")
	}
	target := filepath.Join(dir, "forwarded.sock")
	listener, err := net.Listen("unix", target)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := agentrun.SetConnectionAuthSock(link, target); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("unix", os.Getenv("SSH_AUTH_SOCK"))
	if err != nil {
		t.Fatalf("newly forwarded agent is not reachable on inherited path: %v", err)
	}
	conn.Close()
	if err := agentrun.SetConnectionAuthSock(link, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("the connection without forwarding kept the previous link: %v", err)
	}
}

func TestDaemonSocketUnderHomeWithSpaces(t *testing.T) {
	const root = "/remote project"
	home := filepath.Join(socketFixtureDir(t), "remote home")
	t.Setenv("HOME", home)
	t.Setenv(agentpaths.HomeEnv, "")

	listenPaths, err := agentrun.For(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := filepath.Dir(listenPaths.Sock), filepath.Join(home, ".nexus-code", "run"); got != want {
		t.Fatalf("socket directory = %q, want %q", got, want)
	}
	if err := listenPaths.EnsureSocketDir(); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", listenPaths.Sock)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	dialPaths, err := agentrun.For(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("unix", dialPaths.Sock)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

func TestDaemonSocketFitsWhenRuntimePathIsLong(t *testing.T) {
	runtimeDir := filepath.Join(t.TempDir(), strings.Repeat("한", 36))
	t.Setenv(agentpaths.HomeEnv, runtimeDir)
	paths, err := agentrun.For("/remote project", "test")
	if err != nil {
		t.Fatal(err)
	}
	socketDir := filepath.Dir(paths.Sock)
	if socketDir == filepath.Dir(paths.Lock) || !strings.HasPrefix(paths.Log, runtimeDir) {
		t.Fatalf("socket and persistent paths = %+v", paths)
	}
	if err := os.Symlink(t.TempDir(), socketDir); err != nil {
		t.Fatal(err)
	}
	if err := paths.EnsureSocketDir(); err == nil {
		t.Fatal("accepted a symlink as the short runtime directory")
	}
	if err := os.Remove(socketDir); err != nil {
		t.Fatal(err)
	}
	if err := paths.EnsureSocketDir(); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(socketDir)
	listener, err := net.Listen("unix", paths.Sock)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	dialPaths, err := agentrun.For("/remote project", "test")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("unix", dialPaths.Sock)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
