//go:build darwin || linux

package agentpaths_test

import (
	"errors"
	"fmt"
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
	refusedFor(t, wide, "its mode is 0755, not 0700")

	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	refusedFor(t, link, "it is a symbolic link")

	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	refusedFor(t, file, "it is not a directory")
}

func refusedFor(t *testing.T, dir, reason string) {
	t.Helper()
	err := agentpaths.EnsurePrivateDir(dir)
	var refused *agentpaths.NotPrivateError
	if !errors.As(err, &refused) || !errors.Is(err, agentpaths.ErrNotPrivate) {
		t.Fatalf("EnsurePrivateDir(%s) = %v, want a NotPrivateError", dir, err)
	}
	if refused.Dir != dir || refused.Reason != reason {
		t.Fatalf("refused %s for %q, want %s for %q", refused.Dir, refused.Reason, dir, reason)
	}
	if want := fmt.Sprintf("agentpaths: socket directory %q must be a private directory owned by the current user: %s", dir, reason); err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
}
