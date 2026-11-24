//go:build darwin || linux

package agentpaths_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func TestEnsurePrivateDirCreatesAnOwnerOnlyDirectory(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "private")
	if err := agentpaths.EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v, want a 0700 directory", info.Mode())
	}
	if err := agentpaths.EnsurePrivateDir(dir); err != nil {
		t.Fatalf("second call: %v", err)
	}
}

func TestEnsurePrivateDirRefusesWideOrLinkedDirectories(t *testing.T) {
	base := shortTempDir(t)
	wide := filepath.Join(base, "wide")
	if err := os.Mkdir(wide, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(wide, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := agentpaths.EnsurePrivateDir(wide); err == nil {
		t.Fatal("accepted a 0755 directory")
	}

	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := agentpaths.EnsurePrivateDir(link); err == nil {
		t.Fatal("accepted a symlink")
	}
}
