package agentpaths_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// TestRoot_ReturnsAbsolutePathUnderHome verifies that Root() returns a path
// ending with "/.nexus-code" and rooted under the user's home directory.
func TestRoot_ReturnsAbsolutePathUnderHome(t *testing.T) {
	got, err := agentpaths.Root()
	if err != nil {
		t.Fatalf("Root() error: %v", err)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("os.UserHomeDir() error: %v", err)
	}

	want := filepath.Join(home, ".nexus-code")
	if got != want {
		t.Errorf("Root() = %q; want %q", got, want)
	}

	if !filepath.IsAbs(got) {
		t.Errorf("Root() = %q is not absolute", got)
	}
}

// TestBinDir_IsChildOfRoot verifies that BinDir() is exactly Root()/bin.
func TestBinDir_IsChildOfRoot(t *testing.T) {
	root, err := agentpaths.Root()
	if err != nil {
		t.Fatalf("Root() error: %v", err)
	}

	got, err := agentpaths.BinDir()
	if err != nil {
		t.Fatalf("BinDir() error: %v", err)
	}

	want := filepath.Join(root, "bin")
	if got != want {
		t.Errorf("BinDir() = %q; want %q", got, want)
	}

	if !strings.HasPrefix(got, root) {
		t.Errorf("BinDir() %q is not under root %q", got, root)
	}
}

// TestSocketsDir_IsChildOfRoot verifies that SocketsDir() is exactly Root()/sockets.
func TestSocketsDir_IsChildOfRoot(t *testing.T) {
	root, err := agentpaths.Root()
	if err != nil {
		t.Fatalf("Root() error: %v", err)
	}

	got, err := agentpaths.SocketsDir()
	if err != nil {
		t.Fatalf("SocketsDir() error: %v", err)
	}

	want := filepath.Join(root, "sockets")
	if got != want {
		t.Errorf("SocketsDir() = %q; want %q", got, want)
	}

	if !strings.HasPrefix(got, root) {
		t.Errorf("SocketsDir() %q is not under root %q", got, root)
	}
}

// TestEnsureDir_IdempotentAndMode verifies that EnsureDir creates a directory
// with 0700 permissions and succeeds when called a second time (idempotence).
func TestEnsureDir_IdempotentAndMode(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "a", "b", "c")

	// First call — creates all parents.
	if err := agentpaths.EnsureDir(target); err != nil {
		t.Fatalf("EnsureDir (first call) error: %v", err)
	}

	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("Stat after EnsureDir: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("EnsureDir did not create a directory at %q", target)
	}

	// Verify 0700 permissions (owner rwx, group/other none).
	// os.MkdirAll on some systems inherits umask, so we check the mask explicitly.
	mode := info.Mode().Perm()
	if mode != 0700 {
		t.Errorf("EnsureDir permission = %04o; want 0700", mode)
	}

	// Second call — must be idempotent (no error).
	if err := agentpaths.EnsureDir(target); err != nil {
		t.Fatalf("EnsureDir (second call / idempotent) error: %v", err)
	}
}

// TestEnsureDir_ExistingDir succeeds when the path already exists as a directory.
func TestEnsureDir_ExistingDir(t *testing.T) {
	existing := t.TempDir()
	if err := agentpaths.EnsureDir(existing); err != nil {
		t.Fatalf("EnsureDir on existing dir error: %v", err)
	}
}
