package agentpaths_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func TestEnsureDir_IdempotentAndMode(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "a", "b", "c")

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

	mode := info.Mode().Perm()
	if runtime.GOOS != "windows" && mode != 0700 {
		t.Errorf("EnsureDir permission = %04o; want 0700", mode)
	}

	if err := agentpaths.EnsureDir(target); err != nil {
		t.Fatalf("EnsureDir (second call / idempotent) error: %v", err)
	}
}
