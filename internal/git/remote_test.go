package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestRemoteAddServiceTempRepo verifies RemoteAdd adds a remote to a repository.
func TestRemoteAddServiceTempRepo(t *testing.T) {
	root := t.TempDir()
	remoteGitCmd(t, root, "init", "-b", "main")
	remoteGitCmd(t, root, "config", "user.email", "nexus@example.test")
	remoteGitCmd(t, root, "config", "user.name", "Nexus Test")
	remoteWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	remoteGitCmd(t, root, "add", "f.txt")
	remoteGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)
	_, err := service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/repo.git"}`))
	if err != nil {
		t.Fatalf("RemoteAdd returned error: %v", err)
	}

	// Verify via git remote list.
	out := remoteGitCmdOutput(t, root, "remote")
	if strings.TrimSpace(out) != "origin" {
		t.Errorf("git remote after add = %q, want \"origin\"", strings.TrimSpace(out))
	}
}

// TestRemoteAddDuplicateName verifies duplicate remote name surfaces as remote-exists.
func TestRemoteAddDuplicateName(t *testing.T) {
	root := t.TempDir()
	remoteGitCmd(t, root, "init", "-b", "main")
	remoteGitCmd(t, root, "config", "user.email", "nexus@example.test")
	remoteGitCmd(t, root, "config", "user.name", "Nexus Test")
	remoteWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	remoteGitCmd(t, root, "add", "f.txt")
	remoteGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)
	_, _ = service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/a.git"}`))
	_, err := service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/b.git"}`))
	if err == nil {
		t.Fatal("RemoteAdd with duplicate name should return error")
	}
	// The classifier maps "already exists" → KindRemoteExists; check the message contains a hint.
	lowerErr := strings.ToLower(err.Error())
	if !strings.Contains(lowerErr, "remote-exists") && !strings.Contains(lowerErr, "already exists") && !strings.Contains(lowerErr, "exists") {
		t.Errorf("RemoteAdd duplicate error = %q, want remote-exists hint", err.Error())
	}
}

// TestRemoteRemoveServiceTempRepo verifies RemoteRemove removes a remote.
func TestRemoteRemoveServiceTempRepo(t *testing.T) {
	root := t.TempDir()
	remoteGitCmd(t, root, "init", "-b", "main")
	remoteGitCmd(t, root, "config", "user.email", "nexus@example.test")
	remoteGitCmd(t, root, "config", "user.name", "Nexus Test")
	remoteWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	remoteGitCmd(t, root, "add", "f.txt")
	remoteGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)
	_, _ = service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/repo.git"}`))
	_, err := service.RemoteRemove(context.Background(), json.RawMessage(`{"name":"origin"}`))
	if err != nil {
		t.Fatalf("RemoteRemove returned error: %v", err)
	}

	out := remoteGitCmdOutput(t, root, "remote")
	if strings.TrimSpace(out) != "" {
		t.Errorf("git remote after remove = %q, want empty", strings.TrimSpace(out))
	}
}

// TestRemoteRemoveNotFound verifies non-existent remote surfaces as remote-not-found.
func TestRemoteRemoveNotFound(t *testing.T) {
	root := t.TempDir()
	remoteGitCmd(t, root, "init", "-b", "main")
	remoteGitCmd(t, root, "config", "user.email", "nexus@example.test")
	remoteGitCmd(t, root, "config", "user.name", "Nexus Test")
	remoteWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	remoteGitCmd(t, root, "add", "f.txt")
	remoteGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)
	_, err := service.RemoteRemove(context.Background(), json.RawMessage(`{"name":"nonexistent"}`))
	if err == nil {
		t.Fatal("RemoteRemove of nonexistent remote should return error")
	}
	lowerErr := strings.ToLower(err.Error())
	if !strings.Contains(lowerErr, "remote-not-found") && !strings.Contains(lowerErr, "not found") && !strings.Contains(lowerErr, "remote") {
		t.Errorf("RemoteRemove not-found error = %q, want remote-not-found", err.Error())
	}
}

// TestRemoteNameInvalidRejected verifies invalid remote names are rejected.
func TestRemoteNameInvalidRejected(t *testing.T) {
	service := New(t.TempDir())
	cases := []string{"", "-bad", "has space"}
	for _, name := range cases {
		raw, _ := json.Marshal(map[string]string{"name": name, "url": "https://example.invalid/r.git"})
		_, err := service.RemoteAdd(context.Background(), raw)
		if err == nil {
			t.Errorf("RemoteAdd(%q) should reject invalid name", name)
		}
	}
}

// TestRemoteRegisteredWithDispatcher verifies all remote methods are dispatched.
func TestRemoteRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	remoteGitCmd(t, root, "init", "-b", "main")
	remoteGitCmd(t, root, "config", "user.email", "nexus@example.test")
	remoteGitCmd(t, root, "config", "user.name", "Nexus Test")
	remoteWriteFile(t, filepath.Join(root, "f.txt"), "hello\n")
	remoteGitCmd(t, root, "add", "f.txt")
	remoteGitCmd(t, root, "commit", "-m", "initial")

	d := dispatch.New()
	Register(d, New(root))

	// git.remote.add a known URL — will succeed.
	res := d.Dispatch(context.Background(), proto.Request{
		ID:     "1",
		Method: "git.remote.add",
		Params: json.RawMessage(`{"name":"upstream","url":"https://example.invalid/r.git"}`),
	})
	if res.Error != nil {
		t.Fatalf("git.remote.add dispatch returned error: %#v", res.Error)
	}

	// git.remote.remove the remote we just added.
	res = d.Dispatch(context.Background(), proto.Request{
		ID:     "2",
		Method: "git.remote.remove",
		Params: json.RawMessage(`{"name":"upstream"}`),
	})
	if res.Error != nil {
		t.Fatalf("git.remote.remove dispatch returned error: %#v", res.Error)
	}
}

// remoteGitCmd runs a git command inside the test repo.
func remoteGitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// remoteGitCmdOutput runs git and returns stdout as a string.
func remoteGitCmdOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}

// remoteWriteFile writes content to a file.
func remoteWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
