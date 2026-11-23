package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func linkedWorktree(t *testing.T) (repo, worktree, gitDir string) {
	t.Helper()
	repo = newRepo(t)
	worktree = filepath.Join(t.TempDir(), "linked")
	runGit(t, repo, "worktree", "add", "-b", "linked", worktree)
	return repo, worktree, detect(t, New(worktree), worktree).GitDir
}

func TestResolveGitDir_AcceptsALinkedWorktreesOwnGitDir(t *testing.T) {
	t.Parallel()
	repo, worktree, gitDir := linkedWorktree(t)
	if isInside(gitDir, worktree) {
		t.Fatalf("gitDir %q is inside the worktree; the test needs it outside", gitDir)
	}
	service := New(worktree)

	got, err := service.resolveGitDir(context.Background(), gitDir)
	if err != nil {
		t.Fatalf("resolveGitDir(%q): %v", gitDir, err)
	}
	if got != filepath.Clean(gitDir) {
		t.Errorf("resolveGitDir(%q) = %q", gitDir, got)
	}

	params := mustJSON(t, MetadataParams{GitDir: gitDir})
	if _, err := service.Metadata(context.Background(), params); err != nil {
		t.Errorf("Metadata(%q): %v", gitDir, err)
	}

	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(filepath.Join(repo, ".git"), alias); err != nil {
		t.Logf("skipping the symlink case: symlinks unavailable: %v", err)
	} else {
		viaLink := filepath.Join(alias, "worktrees", filepath.Base(gitDir))
		if _, err := service.resolveGitDir(context.Background(), viaLink); err != nil {
			t.Errorf("resolveGitDir(%q): %v", viaLink, err)
		}
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		upper := filepath.Join(filepath.Dir(gitDir), strings.ToUpper(filepath.Base(gitDir)))
		if _, statErr := os.Stat(upper); statErr == nil {
			if _, err := service.resolveGitDir(context.Background(), upper); err != nil {
				t.Errorf("resolveGitDir(%q): %v", upper, err)
			}
		}
	}
}

func TestResolveGitDir_RefusesDirectoriesGitDoesNotNameForTheWorkspace(t *testing.T) {
	t.Parallel()
	repo, worktree, gitDir := linkedWorktree(t)
	other := newRepo(t)
	arbitrary := t.TempDir()
	service := New(worktree)

	refused := map[string]string{
		"another repository's .git":        filepath.Join(other, ".git"),
		"an arbitrary folder":              arbitrary,
		"the main repository's .git":       filepath.Join(repo, ".git"),
		"a folder inside the git dir":      filepath.Join(gitDir, "logs"),
		"a sibling worktree's git dir":     filepath.Join(filepath.Dir(gitDir), "missing"),
		"the git dir's parent by dot-dot":  filepath.Join(gitDir, ".."),
		"a missing path beside the gitdir": gitDir + "-other",
	}
	if err := os.MkdirAll(filepath.Join(gitDir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, path := range refused {
		if _, err := service.resolveGitDir(context.Background(), path); err == nil {
			t.Errorf("%s: resolveGitDir(%q) accepted it", name, path)
		}
		raw, _ := json.Marshal(MetadataParams{GitDir: path})
		if _, err := service.Metadata(context.Background(), raw); err == nil {
			t.Errorf("%s: Metadata(%q) accepted it", name, path)
		}
	}
}
