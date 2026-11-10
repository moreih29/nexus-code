package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func changeStatsOf(t *testing.T, root string, params string) ChangeStats {
	t.Helper()
	res, err := New(root).ChangeStats(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("ChangeStats returned error: %v", err)
	}
	stats, ok := res.(ChangeStats)
	if !ok {
		t.Fatalf("ChangeStats result type = %T", res)
	}
	return stats
}

func statsByPath(stats ChangeStats) map[string]FileLineStats {
	byPath := map[string]FileLineStats{}
	for _, file := range stats.Files {
		byPath[file.Path] = file
	}
	return byPath
}

// Staged and unstaged edits count together against HEAD, a rename under its
// new path, an untracked file as all added, and a binary file without counts.
func TestChangeStatsCountsLinesPerFile(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	writeFile(t, filepath.Join(root, "moved.txt"), "one\ntwo\nthree\n")
	writeFile(t, filepath.Join(root, "gone.txt"), "a\nb\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-m", "files")

	writeFile(t, filepath.Join(root, "README.md"), "changed\nmore\n")
	runGit(t, root, "add", "README.md")
	writeFile(t, filepath.Join(root, "README.md"), "changed\nmore\nlast")
	runGit(t, root, "mv", "moved.txt", "renamed.txt")
	runGit(t, root, "rm", "-q", "gone.txt")
	writeDir(t, filepath.Join(root, "sub"))
	writeFile(t, filepath.Join(root, "sub", "new.txt"), "x\ny\nz")
	writeFile(t, filepath.Join(root, "blob.bin"), "a\x00b")
	writeFile(t, filepath.Join(root, ".gitignore"), "ignored.log\n")
	writeFile(t, filepath.Join(root, "ignored.log"), "skip\n")

	got := statsByPath(changeStatsOf(t, root, `{}`))
	want := map[string]FileLineStats{
		"README.md":   {Path: "README.md", Added: 3, Deleted: 1},
		"renamed.txt": {Path: "renamed.txt"},
		"gone.txt":    {Path: "gone.txt", Deleted: 2},
		"sub/new.txt": {Path: "sub/new.txt", Added: 3},
		"blob.bin":    {Path: "blob.bin", Binary: true},
		".gitignore":  {Path: ".gitignore", Added: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stats = %#v\nwant %#v", got, want)
	}
}

// A repository without commits has its staged and untracked files counted
// against the empty tree.
func TestChangeStatsWithoutCommits(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	runGit(t, root, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(root, "staged.txt"), "a\nb\n")
	runGit(t, root, "add", "staged.txt")
	writeFile(t, filepath.Join(root, "loose.txt"), "c\n")

	got := statsByPath(changeStatsOf(t, root, `{"base":"main"}`))
	want := map[string]FileLineStats{
		"staged.txt": {Path: "staged.txt", Added: 2},
		"loose.txt":  {Path: "loose.txt", Added: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stats = %#v\nwant %#v", got, want)
	}
}

func TestChangeStatsRefusesOptionLikeBase(t *testing.T) {
	t.Parallel()
	_, err := New(t.TempDir()).ChangeStats(context.Background(), json.RawMessage(`{"base":"--output=x"}`))
	if err == nil || !strings.Contains(err.Error(), "base") {
		t.Fatalf("err = %v, want a refused base", err)
	}
}

func TestParseNumstatZ(t *testing.T) {
	t.Parallel()
	out := "1\t2\ta.txt\x00-\t-\tbin.dat\x000\t0\t\x00old name.txt\x00new name.txt\x00"
	want := []FileLineStats{
		{Path: "a.txt", Added: 1, Deleted: 2},
		{Path: "bin.dat", Binary: true},
		{Path: "new name.txt"},
	}
	if got := parseNumstatZ([]byte(out)); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseNumstatZ = %#v, want %#v", got, want)
	}
}
