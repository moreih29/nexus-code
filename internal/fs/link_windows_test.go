//go:build windows

package fs

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// mklinkJunction makes link a junction to target with cmd's mklink, which
// needs no privilege.
func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v %s", err, out)
	}
}

// A folder with a junction in it, as pnpm leaves in node_modules, copies
// also where Windows refuses the agent a symbolic link: the copy's link is a
// junction to the same directory.
func TestCopyFolderWithJunction(t *testing.T) {
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "store", "pkg"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "store", "pkg", "index.js"), []byte("payload"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "src", "node_modules"), 0o755))
	mklinkJunction(t, filepath.Join(root, "src", "node_modules", "pkg"), filepath.Join(root, "store", "pkg"))

	dispatchOK(t, mustFS(t, root), "fs.copyFile", map[string]any{
		"fromRelPath": "src",
		"toRelPath":   "dst",
	})

	link := filepath.Join(root, "dst", "node_modules", "pkg")
	info, err := os.Lstat(link)
	must(t, err)
	if info.Mode()&(os.ModeSymlink|os.ModeIrregular) == 0 {
		t.Fatalf("copied link mode = %v, want a link, not a copied directory", info.Mode())
	}
	if got, err := os.ReadFile(filepath.Join(link, "index.js")); err != nil || string(got) != "payload" {
		t.Fatalf("read through copied link: bytes=%q err=%v", got, err)
	}
	// It leads to the original directory: a file added there shows through.
	must(t, os.WriteFile(filepath.Join(root, "store", "pkg", "added.js"), nil, 0o644))
	if _, err := os.Stat(filepath.Join(link, "added.js")); err != nil {
		t.Fatalf("copied link does not lead to the original directory: %v", err)
	}
}

// A link to a file that cannot be recreated is copied as the file.
func TestSymlinkFallbackCopiesAFileLinkAsItsFile(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "real.txt")
	must(t, os.WriteFile(src, []byte("payload"), 0o644))
	dst := filepath.Join(root, "copy.txt")

	refused := &os.LinkError{Op: "symlink", Old: "real.txt", New: dst, Err: windows.ERROR_PRIVILEGE_NOT_HELD}
	if err := symlinkFallback(src, dst, "real.txt", refused); err != nil {
		t.Fatalf("symlinkFallback: %v", err)
	}
	if got, err := os.ReadFile(dst); err != nil || string(got) != "payload" {
		t.Fatalf("copy = %q err=%v, want the file's bytes", got, err)
	}
}

// A relative link to a directory leads where the copied link would: into
// the copy.
func TestSymlinkFallbackKeepsARelativeDirectoryLinkRelative(t *testing.T) {
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "src", "real"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "dst", "real"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "dst", "real", "mine.txt"), nil, 0o644))
	dst := filepath.Join(root, "dst", "link")

	refused := &os.LinkError{Op: "symlink", Old: "real", New: dst, Err: windows.ERROR_PRIVILEGE_NOT_HELD}
	// src stands for the link: os.Stat follows a link, so the directory it
	// leads to does as well.
	if err := symlinkFallback(filepath.Join(root, "src", "real"), dst, "real", refused); err != nil {
		t.Fatalf("symlinkFallback: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "mine.txt")); err != nil {
		t.Fatalf("junction does not lead into the copy: %v", err)
	}
}

// Other failures are not stood in for.
func TestSymlinkFallbackLeavesOtherErrors(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "real.txt")
	must(t, os.WriteFile(src, nil, 0o644))
	other := &os.LinkError{Op: "symlink", Err: windows.ERROR_ACCESS_DENIED}
	if err := symlinkFallback(src, filepath.Join(root, "copy.txt"), "real.txt", other); err != other {
		t.Fatalf("symlinkFallback = %v, want the error back", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "copy.txt")); err == nil {
		t.Fatal("symlinkFallback copied the file anyway")
	}
}

// A copy that fails after copying a junction takes the junction away, never
// the directory it leads to.
func TestFailedCopyKeepsWhatAJunctionLeadsTo(t *testing.T) {
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "store", "pkg"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "store", "pkg", "index.js"), []byte("payload"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "src"), 0o755))
	mklinkJunction(t, filepath.Join(root, "src", "a-link"), filepath.Join(root, "store", "pkg"))
	makeUnreadable(t, filepath.Join(root, "src", "z-unreadable.txt"))

	_, err := mustFS(t, root).CopyFile(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "src",
		"toRelPath":   "dst",
	}))
	if err == nil {
		t.Fatal("copying an unreadable file succeeded")
	}
	if _, statErr := os.Lstat(filepath.Join(root, "dst")); !os.IsNotExist(statErr) {
		t.Fatalf("partial copy left behind, err=%v", statErr)
	}
	if got, readErr := os.ReadFile(filepath.Join(root, "store", "pkg", "index.js")); readErr != nil || string(got) != "payload" {
		t.Fatalf("junction target lost: bytes=%q err=%v", got, readErr)
	}
}
