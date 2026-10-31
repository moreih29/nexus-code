package lsp

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFindBinaryTriesTheUsersPathFirst(t *testing.T) {
	root := t.TempDir()
	onPath := writeExecutable(t, filepath.Join(root, "bin"), "gopls")
	theirs := writeExecutable(t, filepath.Join(root, "custom"), "gopls")

	if got := findBinary("gopls", theirs, []string{filepath.Dir(onPath)}); got != theirs {
		t.Fatalf("findBinary() = %q, want the user's %q", got, theirs)
	}
	// Nothing where the user said: the search goes on.
	missing := filepath.Join(root, "nowhere", "gopls")
	if got := findBinary("gopls", missing, []string{filepath.Dir(onPath)}); got != onPath {
		t.Fatalf("findBinary() = %q, want %q", got, onPath)
	}
}

func TestFindBinaryAddsExeToTheUsersPathOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows leaves the extension out")
	}
	root := t.TempDir()
	theirs := writeExecutable(t, filepath.Join(root, "custom"), "gopls")

	withoutExe := strings.TrimSuffix(theirs, ".exe")
	if got := findBinary("gopls", withoutExe, nil); got != theirs {
		t.Fatalf("findBinary() = %q, want %q", got, theirs)
	}
}

func TestFindBinarySearchesTheDirectoriesInOrder(t *testing.T) {
	root := t.TempDir()
	first := writeExecutable(t, filepath.Join(root, "a"), "rust-analyzer")
	_ = writeExecutable(t, filepath.Join(root, "b"), "rust-analyzer")

	dirs := []string{"", filepath.Join(root, "empty"), filepath.Dir(first), filepath.Join(root, "b")}
	if got := findBinary("rust-analyzer", "", dirs); got != first {
		t.Fatalf("findBinary() = %q, want %q", got, first)
	}
	if got := findBinary("gopls", "", dirs); got != "" {
		t.Fatalf("findBinary() = %q for a binary that is nowhere", got)
	}
}

func TestFindBinarySkipsAFileThatCannotRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no execute bit")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "gopls"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := findBinary("gopls", "", []string{dir}); got != "" {
		t.Fatalf("findBinary() = %q, a file without the execute bit", got)
	}
}

func TestSearchDirsIncludeWhereInstallersPutServers(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	t.Setenv("GOBIN", "")
	t.Setenv("GOPATH", filepath.Join(home, "gopath"))

	dirs := strings.Join(searchDirs(home, ""), "\n")
	for _, want := range []string{
		filepath.Join(home, "gopath", "bin"),
		filepath.Join(home, "go", "bin"),
		filepath.Join(home, ".cargo", "bin"),
	} {
		if !strings.Contains(dirs, want) {
			t.Fatalf("searchDirs() leaves out %q", want)
		}
	}
}

func TestExpandHome(t *testing.T) {
	home := filepath.Join("/", "home", "me")
	for path, want := range map[string]string{
		"~":                home,
		"~/go/bin/gopls":   filepath.Join(home, "go", "bin", "gopls"),
		"/opt/gopls":       "/opt/gopls",
		"~other/bin/gopls": "~other/bin/gopls",
		"":                 "",
	} {
		if got := expandHome(path, home); got != want {
			t.Errorf("expandHome(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestJoinPathListsKeepsEachDirectoryOnce(t *testing.T) {
	sep := string(os.PathListSeparator)
	got := joinPathLists("/a", "/b"+sep+"/a"+sep, "/c"+sep+"/b")
	if want := strings.Join([]string{"/a", "/b", "/c"}, sep); got != want {
		t.Fatalf("joinPathLists() = %q, want %q", got, want)
	}
}

func TestFindBinaryRefusesAPathForAName(t *testing.T) {
	service := New()
	if _, err := service.FindBinary(context.Background(), mustJSON(t, FindBinaryParams{Name: "../gopls"})); err == nil {
		t.Fatal("FindBinary() took a path as the command name")
	}
}
