package agentpaths_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

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
