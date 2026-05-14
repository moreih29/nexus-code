package git

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestBranchCreateSuccess verifies that BranchCreate creates a new branch.
func TestBranchCreateSuccess(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	service := New(root)
	params := `{"name":"feature"}`
	_, err := service.BranchCreate(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchCreate returned error: %v", err)
	}

	// Verify branch exists.
	out := runGitCommandOutput(t, root, "branch", "--list", "feature")
	if !strings.Contains(out, "feature") {
		t.Errorf("expected branch 'feature' to exist, got: %q", out)
	}
}

// TestBranchCreateExistsError verifies that BranchCreate returns a branch-exists error.
func TestBranchCreateExistsError(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")
	runGitCommand(t, root, "branch", "existing")

	service := New(root)
	params := `{"name":"existing"}`
	_, err := service.BranchCreate(context.Background(), json.RawMessage(params))
	if err == nil {
		t.Fatal("expected BranchCreate to fail for existing branch")
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "exists") && !strings.Contains(msg, "already") {
		t.Errorf("expected branch-exists error, got: %v", err)
	}
}

// TestBranchCreateWithCheckout verifies that BranchCreate with checkout=true switches branch.
func TestBranchCreateWithCheckout(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	service := New(root)
	params := `{"name":"feature","checkout":true}`
	_, err := service.BranchCreate(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchCreate(checkout=true) returned error: %v", err)
	}

	head := strings.TrimSpace(runGitCommandOutput(t, root, "rev-parse", "--abbrev-ref", "HEAD"))
	if head != "feature" {
		t.Errorf("expected HEAD=feature after checkout, got: %q", head)
	}
}

// TestBranchDeleteSuccess verifies that BranchDelete removes a merged branch.
func TestBranchDeleteSuccess(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")
	runGitCommand(t, root, "branch", "to-delete")

	service := New(root)
	params := `{"name":"to-delete"}`
	res, err := service.BranchDelete(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchDelete returned error: %v", err)
	}
	result, ok := res.(BranchDeleteResult)
	if !ok {
		t.Fatalf("BranchDelete result type = %T", res)
	}
	if result.ErrorKind != "" {
		t.Errorf("expected empty errorKind, got %q: %s", result.ErrorKind, result.ErrorMessage)
	}

	out := runGitCommandOutput(t, root, "branch", "--list", "to-delete")
	if strings.TrimSpace(out) != "" {
		t.Errorf("expected branch 'to-delete' to be gone, got: %q", out)
	}
}

// TestBranchDeleteNotFound verifies that BranchDelete returns a typed error for missing branches.
func TestBranchDeleteNotFound(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	service := New(root)
	params := `{"name":"nonexistent"}`
	res, err := service.BranchDelete(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchDelete returned transport error: %v", err)
	}
	result, ok := res.(BranchDeleteResult)
	if !ok {
		t.Fatalf("BranchDelete result type = %T", res)
	}
	if result.ErrorKind == "" {
		t.Error("expected errorKind for missing branch, got empty")
	}
}

// TestBranchDeleteUnmerged verifies that BranchDelete returns force-delete hint for unmerged branch.
func TestBranchDeleteUnmerged(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	// Create unmerged branch with a commit.
	runGitCommand(t, root, "checkout", "-b", "unmerged")
	writeFile(t, filepath.Join(root, "topic.txt"), "topic\n")
	runGitCommand(t, root, "add", "topic.txt")
	runGitCommand(t, root, "commit", "-m", "topic commit")
	runGitCommand(t, root, "checkout", "main")

	service := New(root)
	params := `{"name":"unmerged","force":false}`
	res, err := service.BranchDelete(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchDelete returned transport error: %v", err)
	}
	result, ok := res.(BranchDeleteResult)
	if !ok {
		t.Fatalf("BranchDelete result type = %T", res)
	}
	if result.ErrorKind == "" {
		t.Error("expected errorKind for unmerged branch, got empty")
	}
	if result.ErrorHint == nil || result.ErrorHint.Kind != "force-delete-available" {
		t.Errorf("expected force-delete-available hint, got: %v", result.ErrorHint)
	}
	if result.ErrorHint != nil && result.ErrorHint.Branch != "unmerged" {
		t.Errorf("expected hint.Branch=unmerged, got: %q", result.ErrorHint.Branch)
	}
}

// TestBranchRenameClean verifies that BranchRename renames a branch successfully.
func TestBranchRenameClean(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	service := New(root)
	params := `{"from":"main","to":"trunk"}`
	_, err := service.BranchRename(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchRename returned error: %v", err)
	}

	head := strings.TrimSpace(runGitCommandOutput(t, root, "rev-parse", "--abbrev-ref", "HEAD"))
	if head != "trunk" {
		t.Errorf("expected HEAD=trunk after rename, got: %q", head)
	}
}

// TestBranchFastForwardClean verifies BranchFastForward advances the branch.
func TestBranchFastForwardClean(t *testing.T) {
	// Create a bare remote and clone it.
	remote := t.TempDir()
	runGitCommand(t, remote, "init", "--bare")

	seed := t.TempDir()
	runGitCommand(t, seed, "init", "-b", "main")
	runGitCommand(t, seed, "config", "user.email", "nexus@example.test")
	runGitCommand(t, seed, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(seed, "README.md"), "base\n")
	runGitCommand(t, seed, "add", "README.md")
	runGitCommand(t, seed, "commit", "-m", "initial")
	runGitCommand(t, seed, "remote", "add", "origin", remote)
	runGitCommand(t, seed, "push", "-u", "origin", "main")

	client := t.TempDir()
	runGitCommand(t, client, "clone", remote, ".")
	runGitCommand(t, client, "config", "user.email", "nexus@example.test")
	runGitCommand(t, client, "config", "user.name", "Nexus Test")

	// Push a new commit to the remote from the seed.
	writeFile(t, filepath.Join(seed, "next.txt"), "next\n")
	runGitCommand(t, seed, "add", "next.txt")
	runGitCommand(t, seed, "commit", "-m", "next")
	runGitCommand(t, seed, "push", "origin", "main")

	fromSha := strings.TrimSpace(runGitCommandOutput(t, client, "rev-parse", "HEAD"))

	service := New(client)
	params := `{"branch":"main","remote":"origin","remoteRef":"main"}`
	res, err := service.BranchFastForward(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchFastForward returned error: %v", err)
	}
	result, ok := res.(BranchFastForwardResult)
	if !ok {
		t.Fatalf("BranchFastForward result type = %T", res)
	}
	if !result.Advanced {
		t.Error("expected Advanced=true")
	}
	if result.FromSha != fromSha {
		t.Errorf("FromSha mismatch: got %q, want %q", result.FromSha, fromSha)
	}
	if result.FromSha == result.ToSha {
		t.Error("expected FromSha != ToSha after fast-forward")
	}
}

// TestBranchFastForwardNoOp verifies BranchFastForward reports not-advanced when already up to date.
func TestBranchFastForwardNoOp(t *testing.T) {
	remote := t.TempDir()
	runGitCommand(t, remote, "init", "--bare")

	seed := t.TempDir()
	runGitCommand(t, seed, "init", "-b", "main")
	runGitCommand(t, seed, "config", "user.email", "nexus@example.test")
	runGitCommand(t, seed, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(seed, "README.md"), "base\n")
	runGitCommand(t, seed, "add", "README.md")
	runGitCommand(t, seed, "commit", "-m", "initial")
	runGitCommand(t, seed, "remote", "add", "origin", remote)
	runGitCommand(t, seed, "push", "-u", "origin", "main")

	client := t.TempDir()
	runGitCommand(t, client, "clone", remote, ".")
	runGitCommand(t, client, "config", "user.email", "nexus@example.test")
	runGitCommand(t, client, "config", "user.name", "Nexus Test")

	service := New(client)
	params := `{"branch":"main","remote":"origin","remoteRef":"main"}`
	res, err := service.BranchFastForward(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("BranchFastForward (no-op) returned error: %v", err)
	}
	result, ok := res.(BranchFastForwardResult)
	if !ok {
		t.Fatalf("BranchFastForward result type = %T", res)
	}
	if result.Advanced {
		t.Error("expected Advanced=false when already up to date")
	}
	if result.FromSha != result.ToSha {
		t.Error("expected FromSha == ToSha for no-op fast-forward")
	}
}

// runGitCommandOutput runs a git command and returns stdout as a string.
func runGitCommandOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}
