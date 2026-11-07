package agentpaths_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// TestLayout pins the ~/.nexus-code layout. Root, BinDir and SocketsDir must
// match src/main/infra/agent/runtimeDirs.ts.
func TestLayout(t *testing.T) {
	t.Setenv(agentpaths.HomeEnv, "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("os.UserHomeDir() error: %v", err)
	}
	root := filepath.Join(home, ".nexus-code")
	for _, tc := range []struct {
		name string
		dir  func() (string, error)
		want string
	}{
		{"Root", agentpaths.Root, root},
		{"BinDir", agentpaths.BinDir, filepath.Join(root, "bin")},
		{"SocketsDir", agentpaths.SocketsDir, filepath.Join(root, "sockets")},
		{"RunDir", agentpaths.RunDir, filepath.Join(root, "run")},
	} {
		got, err := tc.dir()
		if err != nil {
			t.Errorf("%s() error: %v", tc.name, err)
		} else if got != tc.want {
			t.Errorf("%s() = %q; want %q", tc.name, got, tc.want)
		}
	}
}

// TestRoot_NamedByTheEnvironment: a copy of the app beside the installed one
// keeps its files apart.
func TestRoot_NamedByTheEnvironment(t *testing.T) {
	named := filepath.Join(t.TempDir(), "qa")
	t.Setenv(agentpaths.HomeEnv, named)
	if got, err := agentpaths.Root(); err != nil || got != named {
		t.Fatalf("Root() = %q, %v; want %q", got, err, named)
	}
	if got, err := agentpaths.SocketsDir(); err != nil || got != filepath.Join(named, "sockets") {
		t.Fatalf("SocketsDir() = %q, %v", got, err)
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
	if runtime.GOOS != "windows" && mode != 0700 { // Windows keeps no POSIX mode bits.
		t.Errorf("EnsureDir permission = %04o; want 0700", mode)
	}

	// Second call — must be idempotent (no error).
	if err := agentpaths.EnsureDir(target); err != nil {
		t.Fatalf("EnsureDir (second call / idempotent) error: %v", err)
	}
}
