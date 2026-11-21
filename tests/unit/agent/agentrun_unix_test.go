//go:build darwin || linux

package agent_test

import (
	"net"
	"os"
	"path/filepath"
	"testing"

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
