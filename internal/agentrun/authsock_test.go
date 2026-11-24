//go:build !windows

package agentrun

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func agentSockDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nxa-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func listenAgent(t *testing.T, path string) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen %s: %v", path, err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = conn.Write([]byte(filepath.Base(path)))
			_ = conn.Close()
		}
	}()
}

func dialAgent(t *testing.T, path string) string {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	defer conn.Close()
	buf := make([]byte, 64)
	n, _ := conn.Read(buf)
	return string(buf[:n])
}

func TestPointAuthSockFollowsTheLatestConnection(t *testing.T) {
	dir := agentSockDir(t)
	first, second := filepath.Join(dir, "a1"), filepath.Join(dir, "a2")
	listenAgent(t, first)
	listenAgent(t, second)
	link := filepath.Join(dir, "ws.agent")

	if err := PointAuthSock(link, first); err != nil {
		t.Fatal(err)
	}
	if got := dialAgent(t, link); got != "a1" {
		t.Fatalf("link reached %q, want a1", got)
	}
	if err := PointAuthSock(link, second); err != nil {
		t.Fatal(err)
	}
	if got := dialAgent(t, link); got != "a2" {
		t.Fatalf("link reached %q after re-point, want a2", got)
	}
}

func TestPointAuthSockIgnoresMissingAndNonSocketTargets(t *testing.T) {
	dir := agentSockDir(t)
	link := filepath.Join(dir, "ws.agent")
	agent := filepath.Join(dir, "a1")
	listenAgent(t, agent)
	must(t, PointAuthSock(link, agent))

	file := filepath.Join(dir, "plain")
	must(t, os.WriteFile(file, nil, 0o600))
	for _, target := range []string{"", link, file, filepath.Join(dir, "gone")} {
		_ = PointAuthSock(link, target)
		if got, err := os.Readlink(link); err != nil || got != agent {
			t.Fatalf("PointAuthSock(%q) changed the link to %q (%v)", target, got, err)
		}
	}
}

func TestAdoptAuthSockExportsTheLink(t *testing.T) {
	dir := agentSockDir(t)
	agent := filepath.Join(dir, "a1")
	listenAgent(t, agent)
	link := filepath.Join(dir, "ws.agent")

	t.Setenv("SSH_AUTH_SOCK", agent)
	if !AdoptAuthSock(link) || os.Getenv("SSH_AUTH_SOCK") != link {
		t.Fatalf("SSH_AUTH_SOCK = %q, want %q", os.Getenv("SSH_AUTH_SOCK"), link)
	}
	if got := dialAgent(t, link); got != "a1" {
		t.Fatalf("link reached %q, want a1", got)
	}
}

func TestAdoptAuthSockLeavesEnvironmentWhenLinkIsTooLong(t *testing.T) {
	dir := agentSockDir(t)
	agent := filepath.Join(dir, "a1")
	listenAgent(t, agent)

	t.Setenv("SSH_AUTH_SOCK", agent)
	long := filepath.Join(dir, strings.Repeat("x", agentpaths.MaxSocketPathLen())+".agent")
	if AdoptAuthSock(long) || os.Getenv("SSH_AUTH_SOCK") != agent {
		t.Fatal("exported a link longer than sun_path allows")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
