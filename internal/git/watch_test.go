package git

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/fsnotify/fsnotify"
)

// Git LFS and submodule object stores (.git/lfs/objects,
// .git/modules/<path>/objects) are as large and as irrelevant to git.changed
// as .git/objects; watching them cost one kqueue descriptor per fan-out
// directory on macOS. A directory merely named objects or logs elsewhere
// (here a branch namespace) is still watched.
func TestAddGitWatchDirsSkipsObjectStores(t *testing.T) {
	gitDir := t.TempDir()
	for _, dir := range []string{
		"refs/heads/objects",
		"objects/ab",
		"logs/refs",
		"lfs/objects/ab/cd",
		"lfs/tmp",
		"modules/sub/refs/heads",
		"modules/sub/objects/ab",
		"modules/sub/logs/refs",
		"modules/vendor/lib/objects/ab",
		"modules/sub/modules/inner/objects/ab",
	} {
		if err := os.MkdirAll(filepath.Join(gitDir, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{".", "modules/sub", "modules/vendor/lib", "modules/sub/modules/inner"} {
		if err := os.WriteFile(filepath.Join(gitDir, dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	if err := addGitWatchDirs(watcher, gitDir, gitDir); err != nil {
		t.Fatal(err)
	}

	assertWatched(t, watcher, gitDir, []string{
		".",
		"lfs",
		"lfs/tmp",
		"modules",
		"modules/sub",
		"modules/sub/modules",
		"modules/sub/modules/inner",
		"modules/sub/refs",
		"modules/sub/refs/heads",
		"modules/vendor",
		"modules/vendor/lib",
		"refs",
		"refs/heads",
		"refs/heads/objects",
	})
}

// A submodule cloned after git.watch started is picked up from its Create
// event; its object store must be skipped there too, which needs the path
// judged relative to the watched .git directory rather than the new one.
func TestGitWatchSkipsObjectStoreOfNewSubmodule(t *testing.T) {
	gitDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(gitDir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	entry := &watchEntry{gitDir: gitDir, watcher: watcher, done: make(chan struct{})}
	defer entry.close()
	if err := addGitWatchDirs(watcher, gitDir, gitDir); err != nil {
		t.Fatal(err)
	}

	// The first submodule creates .git/modules with the clone already in it.
	sub := filepath.Join(gitDir, "modules", "vendor", "lib")
	if err := os.MkdirAll(filepath.Join(sub, "objects", "ab"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(t.TempDir())
	defer s.Close()
	s.handleGitWatchEvent(entry, fsnotify.Event{Name: filepath.Join(gitDir, "modules"), Op: fsnotify.Create})

	assertWatched(t, watcher, gitDir, []string{".", "modules", "modules/vendor", "modules/vendor/lib"})
}

// kqueue on macOS reports a Chmod for every read of .git/index, as its access
// time moves; counting it re-ran status after each status. Writes still count.
func TestGitWatchIgnoresAttributeOnlyEvents(t *testing.T) {
	gitDir := t.TempDir()
	entry := &watchEntry{gitDir: gitDir, done: make(chan struct{})}
	s := New(t.TempDir())
	defer s.Close()
	index := filepath.Join(gitDir, "index")

	s.handleGitWatchEvent(entry, fsnotify.Event{Name: index, Op: fsnotify.Chmod})
	if len(s.gitDirty) != 0 {
		t.Fatalf("Chmod marked %v dirty", s.gitDirty)
	}
	s.handleGitWatchEvent(entry, fsnotify.Event{Name: index, Op: fsnotify.Write | fsnotify.Chmod})
	if _, ok := s.gitDirty[gitDir]; !ok {
		t.Fatal("Write did not mark the git dir dirty")
	}
}

func assertWatched(t *testing.T, watcher *fsnotify.Watcher, gitDir string, want []string) {
	t.Helper()
	var got []string
	for _, path := range watcher.WatchList() {
		rel, err := filepath.Rel(gitDir, path)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, filepath.ToSlash(rel))
	}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("watched dirs:\n got  %v\n want %v", got, want)
	}
}
