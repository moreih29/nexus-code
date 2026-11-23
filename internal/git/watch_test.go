package git

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

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

func TestGitWatchRefreshesRepositoriesBeyondBatchBudget(t *testing.T) {
	s := New(t.TempDir())
	s.timer = time.NewTimer(time.Hour)
	defer s.timer.Stop()
	var refreshed []string
	s.SetEventSink(func(_ string, payload any) error {
		refreshed = append(refreshed, payload.(ChangedPayload).GitDir)
		return nil
	})
	for i := 0; i < 128; i++ {
		s.bufferGitDirty(strconv.Itoa(i))
	}
	s.bufferGitDirty("overflow")
	if len(s.gitDirty) != 128 || !slices.Equal(refreshed, []string{"overflow"}) {
		t.Fatalf("queued %d repositories, refreshed %v", len(s.gitDirty), refreshed)
	}
}
