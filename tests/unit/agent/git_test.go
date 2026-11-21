package agent_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	agentgit "github.com/nexus-code/nexus-code/internal/git"
)

func gitRun(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is required")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	root := t.TempDir()
	gitRun(t, root, "init", "-q")
	gitRun(t, root, "config", "user.name", "Nexus Test")
	gitRun(t, root, "config", "user.email", "nexus@example.test")
	gitRun(t, root, "config", "commit.gpgSign", "false")
	return root
}

func writeText(t *testing.T, root, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestStageContentPreservesPOSIXBackslash(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("backslash is a path separator on Windows")
	}
	root := gitRepo(t)
	if err := os.Mkdir(filepath.Join(root, "a"), 0700); err != nil {
		t.Fatal(err)
	}
	const flat, nested = `a\b.txt`, "a/b.txt"
	writeText(t, root, flat, "flat name\n")
	writeText(t, root, nested, "nested name\n")
	gitRun(t, root, "--literal-pathspecs", "add", "--", flat, nested)
	service := agentgit.New(root)
	call(t, service.StageContent, agentgit.StageContentParams{RelPath: flat, Content: "partial edit\n"})
	if index := gitRun(t, root, "show", ":"+flat); index != "partial edit\n" {
		t.Fatalf("selected path's index = %q", index)
	}
	if index := gitRun(t, root, "show", ":"+nested); index != "nested name\n" {
		t.Fatalf("unrelated path's index = %q", index)
	}
}
