package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func stageContentRepo(t *testing.T) string {
	t.Helper()
	return fromTemplate(t, "stage-content", func(t *testing.T, root string) {
		runGit(t, root, "init", "-b", "main")
		runGit(t, root, "config", "user.email", "nexus@example.test")
		runGit(t, root, "config", "user.name", "Nexus Test")
		runGit(t, root, "config", "core.fileMode", "true")
		writeFile(t, filepath.Join(root, "a.txt"), "one\ntwo\n")
		runGit(t, root, "add", "a.txt")
		runGit(t, root, "commit", "-m", "init")
	})
}

func stageContent(t *testing.T, root string, relPath string, content string) error {
	t.Helper()
	params, _ := json.Marshal(StageContentParams{Cwd: root, RelPath: relPath, Content: content})
	_, err := New(root).StageContent(context.Background(), params)
	return err
}

func TestStageContent_WritesIndexOnly(t *testing.T) {
	t.Parallel()
	root := stageContentRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\nTWO\nthree\n")

	if err := stageContent(t, root, "a.txt", "one\nTWO\n"); err != nil {
		t.Fatalf("StageContent: %v", err)
	}
	if got := runGit(t, root, "show", ":a.txt"); got != "one\nTWO\n" {
		t.Errorf("index content = %q", got)
	}
	data, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(data) != "one\nTWO\nthree\n" {
		t.Errorf("working tree changed to %q", data)
	}
	if got := runGit(t, root, "status", "--porcelain"); got != "MM a.txt\n" {
		t.Errorf("status = %q, want MM", got)
	}
}

func TestStageContent_KeepsExecutableMode(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("Windows files have no executable bit for git to read")
	}
	root := stageContentRepo(t)
	script := filepath.Join(root, "run.sh")
	writeFile(t, script, "echo hi\n")
	if err := os.Chmod(script, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "run.sh")

	if err := stageContent(t, root, "run.sh", "echo bye\n"); err != nil {
		t.Fatalf("StageContent: %v", err)
	}
	if got := runGit(t, root, "ls-files", "--stage", "run.sh"); !strings.HasPrefix(got, "100755 ") {
		t.Errorf("index entry = %q, want mode 100755", got)
	}
}

func TestStageContent_AddsNewPathAsRegularFile(t *testing.T) {
	t.Parallel()
	root := stageContentRepo(t)

	if err := stageContent(t, root, "dir/new.txt", "fresh\n"); err != nil {
		t.Fatalf("StageContent: %v", err)
	}
	if got := runGit(t, root, "ls-files", "--stage", "dir/new.txt"); !strings.HasPrefix(got, "100644 ") {
		t.Errorf("index entry = %q, want mode 100644", got)
	}
	if got := runGit(t, root, "show", ":dir/new.txt"); got != "fresh\n" {
		t.Errorf("index content = %q", got)
	}
}

func TestStageContent_ReadsPathLiterally(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("Windows file names cannot hold *")
	}
	root := stageContentRepo(t)
	// As a glob, b*.txt also matches the executable b!.txt, which git lists
	// first; its mode must not leak into b*.txt's entry.
	writeFile(t, filepath.Join(root, "b*.txt"), "glob\n")
	other := filepath.Join(root, "b!.txt")
	writeFile(t, other, "other\n")
	if err := os.Chmod(other, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "--", ":(literal)b*.txt", "b!.txt")

	if err := stageContent(t, root, "b*.txt", "staged\n"); err != nil {
		t.Fatalf("StageContent: %v", err)
	}
	if got := runGit(t, root, "ls-files", "--stage", "--", ":(literal)b*.txt"); !strings.HasPrefix(got, "100644 ") {
		t.Errorf("b*.txt index entry = %q, want mode 100644", got)
	}
	if got := runGit(t, root, "show", ":b!.txt"); got != "other\n" {
		t.Errorf("b!.txt index content = %q, want it untouched", got)
	}
	if got := runGit(t, root, "show", ":b*.txt"); got != "staged\n" {
		t.Errorf("b*.txt index content = %q", got)
	}
}

func TestStageContent_RunsAtTheRepositoryRoot(t *testing.T) {
	t.Parallel()
	root := stageContentRepo(t)
	sub := filepath.Join(root, "sub")
	writeDir(t, sub)

	params, _ := json.Marshal(StageContentParams{Cwd: sub, RelPath: "a.txt", Content: "root\n"})
	if _, err := New(sub).StageContent(context.Background(), params); err != nil {
		t.Fatalf("StageContent: %v", err)
	}
	if got := runGit(t, root, "show", ":a.txt"); got != "root\n" {
		t.Errorf("index content = %q", got)
	}
}

func TestStageContent_RefusesSymlinksAndConflicts(t *testing.T) {
	t.Parallel()
	root := stageContentRepo(t)
	if err := os.Symlink("a.txt", filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	runGit(t, root, "add", "link")
	if err := stageContent(t, root, "link", "b.txt"); err == nil {
		t.Error("staging a symlink succeeded")
	}

	blob := strings.TrimSpace(runGit(t, root, "rev-parse", ":a.txt"))
	cmd := exec.Command("git", "update-index", "--index-info")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader("0 0000000000000000000000000000000000000000\tc.txt\n" +
		"100644 " + blob + " 1\tc.txt\n100644 " + blob + " 2\tc.txt\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("update-index: %v\n%s", err, out)
	}
	if err := stageContent(t, root, "c.txt", "merged\n"); err == nil {
		t.Error("staging a conflicted path succeeded")
	}
}

func TestStageContent_RejectsPathsOutsideTheRepository(t *testing.T) {
	t.Parallel()
	root := stageContentRepo(t)
	for _, relPath := range []string{"../outside.txt", "/etc/passwd", ""} {
		if err := stageContent(t, root, relPath, "x"); err == nil {
			t.Errorf("StageContent(%q) succeeded", relPath)
		}
	}
}
