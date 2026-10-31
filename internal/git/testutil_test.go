package git

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestMain lets the test binary double as the askpass helper: interactive
// commands name os.Executable() as GIT_ASKPASS, as the agent does.
//
// It also keeps the developer's global and system git config, such as their
// own pull.rebase, out of every git command the tests run. Setting it here
// rather than with t.Setenv lets those tests run in parallel.
func TestMain(m *testing.M) {
	if socketPath, ok := AskpassSocketFromEnv(); ok {
		os.Exit(RunAskpassHelper(socketPath, os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	os.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	code := m.Run()
	if templates.root != "" {
		_ = os.RemoveAll(templates.root)
	}
	os.Exit(code)
}

// runGit runs git in dir and returns its stdout. A non-zero exit fails the
// test with git's stderr.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		var stderr []byte
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = exitErr.Stderr
		}
		t.Fatalf("git %v: %v\n%s", args, err, stderr)
	}
	return string(out)
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func writeDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}

// fixtureDir returns tests/fixtures/git/<name>. Go runs tests in the
// package directory.
func fixtureDir(name string) string {
	return filepath.Join("..", "..", "tests", "fixtures", "git", name)
}

func isProtocolError(err error) bool {
	var coded proto.CodedError
	return errors.As(err, &coded) && coded.Code == proto.CodeProtocolError
}

// templates holds the repositories below, each built once per test run on
// first use. Tests get a copy, which costs far less than the git commands
// that build one, on Windows above all.
var templates = struct {
	mu   sync.Mutex
	root string
	dirs map[string]string
}{dirs: map[string]string{}}

// fromTemplate returns a fresh copy of the template called name, which build
// fills in on first use.
func fromTemplate(t *testing.T, name string, build func(t *testing.T, dir string)) string {
	t.Helper()
	src := func() string {
		templates.mu.Lock()
		defer templates.mu.Unlock()
		if dir, ok := templates.dirs[name]; ok {
			return dir
		}
		if templates.root == "" {
			root, err := os.MkdirTemp("", "nexus-git-templates-")
			if err != nil {
				t.Fatalf("create template root: %v", err)
			}
			templates.root = root
		}
		dir, err := os.MkdirTemp(templates.root, name+"-")
		if err != nil {
			t.Fatalf("create template %s: %v", name, err)
		}
		build(t, dir)
		templates.dirs[name] = dir
		return dir
	}()

	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm()|0o200)
	})
	if err != nil {
		t.Fatalf("copy template %s: %v", name, err)
	}
	return dst
}

// seedRepo makes dir a repository on main with README.md ("base\n")
// committed.
func seedRepo(t *testing.T, dir string) {
	t.Helper()
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.email", "nexus@example.test")
	runGit(t, dir, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(dir, "README.md"), "base\n")
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-m", "initial")
	// Sample hooks are a dozen files every copy would carry.
	if err := os.RemoveAll(filepath.Join(dir, ".git", "hooks")); err != nil {
		t.Fatal(err)
	}
}

// newRepo returns a repository on main with README.md ("base\n") committed.
func newRepo(t *testing.T) string {
	t.Helper()
	return fromTemplate(t, "repo", seedRepo)
}

// newConflictRepo returns newRepo checked out on main, with a feature branch
// whose conflict.txt conflicts with main's when merged.
func newConflictRepo(t *testing.T) string {
	t.Helper()
	return fromTemplate(t, "conflict", func(t *testing.T, dir string) {
		seedRepo(t, dir)
		runGit(t, dir, "checkout", "-b", "feature")
		writeFile(t, filepath.Join(dir, "conflict.txt"), "feature\n")
		runGit(t, dir, "add", "conflict.txt")
		runGit(t, dir, "commit", "-m", "feature conflict")
		runGit(t, dir, "checkout", "main")
		writeFile(t, filepath.Join(dir, "conflict.txt"), "main\n")
		runGit(t, dir, "add", "conflict.txt")
		runGit(t, dir, "commit", "-m", "main conflict")
	})
}

// newRemoteAndClient returns a bare remote and a clone of it that tracks its
// main branch, both at newRepo's commit. With behind, the remote has one more
// commit (adding remote.txt) that the client has not fetched.
func newRemoteAndClient(t *testing.T, behind bool) (remote, client string) {
	t.Helper()
	name := "remote-synced"
	if behind {
		name = "remote-behind"
	}
	dir := fromTemplate(t, name, func(t *testing.T, dir string) {
		remote := filepath.Join(dir, "remote")
		seed := filepath.Join(dir, "seed")
		writeDir(t, remote)
		writeDir(t, seed)
		runGit(t, remote, "init", "--bare", "-b", "main")
		seedRepo(t, seed)
		runGit(t, seed, "remote", "add", "origin", remote)
		runGit(t, seed, "push", "-u", "origin", "main")
		runGit(t, dir, "clone", remote, "client")
		client := filepath.Join(dir, "client")
		runGit(t, client, "config", "user.email", "nexus@example.test")
		runGit(t, client, "config", "user.name", "Nexus Test")
		if behind {
			writeFile(t, filepath.Join(seed, "remote.txt"), "remote\n")
			runGit(t, seed, "add", "remote.txt")
			runGit(t, seed, "commit", "-m", "remote commit")
			runGit(t, seed, "push", "origin", "main")
		}
		for _, unused := range []string{seed, filepath.Join(remote, "hooks"), filepath.Join(client, ".git", "hooks")} {
			if err := os.RemoveAll(unused); err != nil {
				t.Fatal(err)
			}
		}
	})
	remote = filepath.Join(dir, "remote")
	client = filepath.Join(dir, "client")
	// The copy still points at the template's remote.
	runGit(t, client, "remote", "set-url", "origin", remote)
	return remote, client
}
