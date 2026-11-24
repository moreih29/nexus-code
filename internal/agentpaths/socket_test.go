package agentpaths_test

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func shortTempDir(t *testing.T) string {
	t.Helper()
	parent := "/tmp"
	if runtime.GOOS == "windows" {
		parent = ""
	}
	dir, err := os.MkdirTemp(parent, "ap-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func pathOfLength(t *testing.T, base string, n int) string {
	t.Helper()
	pad := n - len(base) - 1
	if pad < 1 {
		t.Fatalf("%s is too long to make a %d-byte path", base, n)
	}
	return filepath.Join(base, strings.Repeat("s", pad))
}

func TestMaxSocketPathLenMatchesTheSystem(t *testing.T) {
	want := 107
	if runtime.GOOS == "darwin" {
		want = 103
	}
	if got := agentpaths.MaxSocketPathLen(); got != want {
		t.Fatalf("MaxSocketPathLen() = %d, want %d on %s", got, want, runtime.GOOS)
	}

	base := shortTempDir(t)
	fits := pathOfLength(t, base, agentpaths.MaxSocketPathLen())
	ln, err := net.Listen("unix", fits)
	if err != nil {
		t.Fatalf("listen on a %d-byte path: %v", len(fits), err)
	}
	_ = ln.Close()
	_ = os.Remove(fits)

	over := pathOfLength(t, base, agentpaths.MaxSocketPathLen()+1)
	if ln, err := net.Listen("unix", over); err == nil {
		_ = ln.Close()
		t.Fatalf("listen accepted a %d-byte path", len(over))
	}
	if agentpaths.SocketPathFits(over) || !agentpaths.SocketPathFits(fits) {
		t.Fatal("SocketPathFits disagrees with listen")
	}
}

func TestSocketDirKeepsAPathThatFits(t *testing.T) {
	preferred := shortTempDir(t)
	name := pathOfLength(t, preferred, agentpaths.MaxSocketPathLen())[len(preferred)+1:]
	dir, fallback, err := agentpaths.SocketDir(preferred, name)
	if err != nil || fallback || dir != preferred {
		t.Fatalf("SocketDir = %q, %v, %v; want %q without fallback", dir, fallback, err, preferred)
	}
}

func TestSocketDirFallsBackForALongPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", shortTempDir(t))
	}
	preferred := pathOfLength(t, shortTempDir(t), agentpaths.MaxSocketPathLen())
	const name = "h-0123456789ab.sock"
	dir, fallback, err := agentpaths.SocketDir(preferred, name)
	if err != nil || !fallback {
		t.Fatalf("SocketDir = %q, %v, %v; want a fallback", dir, fallback, err)
	}
	if !agentpaths.SocketPathFits(filepath.Join(dir, name)) {
		t.Fatalf("fallback %s does not fit", dir)
	}
	if runtime.GOOS == "windows" {
		if want := filepath.Join(os.Getenv("USERPROFILE"), ".nexus-code", "sockets"); dir != want {
			t.Fatalf("fallback = %s, want %s", dir, want)
		}
		return
	}
	if !strings.HasPrefix(dir, "/tmp/nexus-code-") {
		t.Fatalf("fallback = %s, want a directory under /tmp", dir)
	}
	again, _, _ := agentpaths.SocketDir(preferred, name)
	other, _, _ := agentpaths.SocketDir(preferred+"x", name)
	if again != dir || other == dir {
		t.Fatalf("fallbacks %s, %s, %s: want one per preferred directory", dir, again, other)
	}
}

func TestSocketDirRefusesWhenTheFallbackDoesNotFit(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the /tmp fallback always fits")
	}
	base := shortTempDir(t)
	profile := pathOfLength(t, base, agentpaths.MaxSocketPathLen())
	t.Setenv("USERPROFILE", profile)
	const name = "h-0123456789ab.sock"
	for _, preferred := range []string{
		filepath.Join(profile, ".nexus-code", "sockets"),
		pathOfLength(t, filepath.Join(base, "named"), agentpaths.MaxSocketPathLen()),
	} {
		dir, _, err := agentpaths.SocketDir(preferred, name)
		var pathErr *agentpaths.SocketPathError
		if !errors.As(err, &pathErr) {
			t.Fatalf("SocketDir(%s) = %q, %v; want a SocketPathError", preferred, dir, err)
		}
		if pathErr.Path != filepath.Join(preferred, name) {
			t.Errorf("error path = %s, want %s", pathErr.Path, filepath.Join(preferred, name))
		}
	}
}
