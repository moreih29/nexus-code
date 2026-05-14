package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Pull tests
// ---------------------------------------------------------------------------

// TestPullAlreadyUpToDate verifies that pull returns alreadyUpToDate when nothing to pull.
func TestPullAlreadyUpToDate(t *testing.T) {
	remote, client := makeRemoteAndClient(t)
	_ = remote

	service := New(client)
	result, err := service.Pull(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Pull returned error: %v", err)
	}

	pr, ok := result.(PullResult)
	if !ok {
		t.Fatalf("expected PullResult, got %T", result)
	}
	if !pr.AlreadyUpToDate {
		t.Errorf("expected alreadyUpToDate=true, got false; summary=%q", pr.Summary)
	}
}

// TestPullFastForward verifies that pull detects a fast-forward after remote has new commits.
func TestPullFastForward(t *testing.T) {
	remote, client := makeRemoteAndClient(t)

	// Push a new commit to remote via a second working-tree clone.
	pusher := t.TempDir()
	runGitCommand(t, pusher, "clone", remote, ".")
	runGitCommand(t, pusher, "config", "user.email", "nexus@example.test")
	runGitCommand(t, pusher, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(pusher, "extra.txt"), "extra\n")
	runGitCommand(t, pusher, "add", "extra.txt")
	runGitCommand(t, pusher, "commit", "-m", "extra commit")
	runGitCommand(t, pusher, "push", "origin", "main")

	service := New(client)
	result, err := service.Pull(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Pull returned error: %v", err)
	}

	pr, ok := result.(PullResult)
	if !ok {
		t.Fatalf("expected PullResult, got %T", result)
	}
	if pr.AlreadyUpToDate {
		t.Errorf("expected alreadyUpToDate=false after new remote commit")
	}
}

// TestPullNoUpstream verifies that pull returns an error when no upstream is configured.
func TestPullNoUpstream(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	service := New(root)
	_, err := service.Pull(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected Pull to fail with no upstream configured")
	}
}

// TestParsePullOutputAlreadyUpToDate verifies parsePullOutput recognizes the up-to-date message.
func TestParsePullOutputAlreadyUpToDate(t *testing.T) {
	stdout := "Already up to date.\n"
	result := parsePullOutput(stdout, "")
	if !result.AlreadyUpToDate {
		t.Errorf("expected alreadyUpToDate=true")
	}
}

// TestParsePullOutputFastForward verifies parsePullOutput detects fast-forward.
func TestParsePullOutputFastForward(t *testing.T) {
	stdout := "Updating abc123..def456\nFast-forward\n README.md | 1 +\n 1 file changed, 1 insertion(+)\n"
	result := parsePullOutput(stdout, "")
	if result.FastForward == nil || !*result.FastForward {
		t.Errorf("expected fastForward=true")
	}
	if result.FilesChanged == nil || *result.FilesChanged != 1 {
		t.Errorf("expected filesChanged=1, got %v", result.FilesChanged)
	}
	if result.Insertions == nil || *result.Insertions != 1 {
		t.Errorf("expected insertions=1, got %v", result.Insertions)
	}
}

// TestParsePullOutputDiffStats verifies parsePullOutput extracts full diff stats.
func TestParsePullOutputDiffStats(t *testing.T) {
	stdout := "Updating abc..def\n 3 files changed, 5 insertions(+), 2 deletions(-)\n"
	result := parsePullOutput(stdout, "")
	if result.FilesChanged == nil || *result.FilesChanged != 3 {
		t.Errorf("expected filesChanged=3, got %v", result.FilesChanged)
	}
	if result.Insertions == nil || *result.Insertions != 5 {
		t.Errorf("expected insertions=5, got %v", result.Insertions)
	}
	if result.Deletions == nil || *result.Deletions != 2 {
		t.Errorf("expected deletions=2, got %v", result.Deletions)
	}
}

// ---------------------------------------------------------------------------
// Push tests
// ---------------------------------------------------------------------------

// TestPushSuccess verifies that push returns pushed=true after a local commit.
func TestPushSuccess(t *testing.T) {
	remote, client := makeRemoteAndClient(t)
	_ = remote

	// Make a local commit to push.
	writeFile(t, filepath.Join(client, "new.txt"), "new\n")
	runGitCommand(t, client, "add", "new.txt")
	runGitCommand(t, client, "commit", "-m", "new commit")

	service := New(client)
	result, err := service.Push(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Push returned error: %v", err)
	}

	pr, ok := result.(PushResult)
	if !ok {
		t.Fatalf("expected PushResult, got %T", result)
	}
	if !pr.Pushed {
		t.Errorf("expected pushed=true, got false; summary=%q", pr.Summary)
	}
}

// TestPushNothingToPush verifies that push returns pushed=false when already up-to-date.
func TestPushNothingToPush(t *testing.T) {
	remote, client := makeRemoteAndClient(t)
	_ = remote

	service := New(client)
	result, err := service.Push(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Push returned error: %v", err)
	}

	pr, ok := result.(PushResult)
	if !ok {
		t.Fatalf("expected PushResult, got %T", result)
	}
	if pr.Pushed {
		t.Errorf("expected pushed=false when nothing to push")
	}
}

// TestPushNonFastForwardError verifies that push returns an error for non-fast-forward.
func TestPushNonFastForwardError(t *testing.T) {
	remote, client := makeRemoteAndClient(t)

	// Push a diverging commit via a second clone to simulate remote history advance.
	other := t.TempDir()
	runGitCommand(t, other, "clone", remote, ".")
	runGitCommand(t, other, "config", "user.email", "nexus@example.test")
	runGitCommand(t, other, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(other, "conflict.txt"), "remote\n")
	runGitCommand(t, other, "add", "conflict.txt")
	runGitCommand(t, other, "commit", "-m", "remote conflict")
	runGitCommand(t, other, "push", "origin", "main")

	// Make a local commit that diverges from the now-advanced remote.
	writeFile(t, filepath.Join(client, "local.txt"), "local\n")
	runGitCommand(t, client, "add", "local.txt")
	runGitCommand(t, client, "commit", "-m", "local diverge")

	service := New(client)
	_, err := service.Push(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected Push to fail for non-fast-forward")
	}
}

// TestParsePushOutputAlreadyUpToDate verifies parsePushOutput for the up-to-date case.
func TestParsePushOutputAlreadyUpToDate(t *testing.T) {
	stderr := "Everything up-to-date\n"
	result := parsePushOutput("", stderr)
	if result.Pushed {
		t.Errorf("expected pushed=false for up-to-date")
	}
}

// TestParsePushOutputPushed verifies parsePushOutput for actual push output.
func TestParsePushOutputPushed(t *testing.T) {
	stderr := "To git@github.com:example/repo.git\n   abc123..def456  main -> main\n"
	result := parsePushOutput("", stderr)
	if !result.Pushed {
		t.Errorf("expected pushed=true for real push")
	}
}

// TestBuildPushArgsForce verifies buildPushArgs returns force-with-lease args.
func TestBuildPushArgsForce(t *testing.T) {
	args := buildPushArgs(PushParams{Force: true})
	if len(args) < 2 || !strings.Contains(strings.Join(args, " "), "force-with-lease") {
		t.Errorf("expected --force-with-lease, got %v", args)
	}
}

// TestBuildPushArgsCustom verifies buildPushArgs passes custom args through unchanged.
func TestBuildPushArgsCustom(t *testing.T) {
	custom := []string{"push", "-u", "origin", "main"}
	args := buildPushArgs(PushParams{Args: custom})
	if strings.Join(args, " ") != strings.Join(custom, " ") {
		t.Errorf("expected custom args %v, got %v", custom, args)
	}
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

// makeRemoteAndClient creates a bare "remote" repo and a cloned "client" repo
// with one initial commit and a push so the client has an upstream.
func makeRemoteAndClient(t *testing.T) (remote, client string) {
	t.Helper()
	remote = t.TempDir()
	runGitCommand(t, remote, "init", "--bare", "-b", "main")

	seed := t.TempDir()
	runGitCommand(t, seed, "init", "-b", "main")
	runGitCommand(t, seed, "config", "user.email", "nexus@example.test")
	runGitCommand(t, seed, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(seed, "README.md"), "base\n")
	runGitCommand(t, seed, "add", "README.md")
	runGitCommand(t, seed, "commit", "-m", "initial")
	runGitCommand(t, seed, "remote", "add", "origin", remote)
	runGitCommand(t, seed, "push", "-u", "origin", "main")

	client = t.TempDir()
	runGitCommand(t, client, "clone", remote, ".")
	runGitCommand(t, client, "config", "user.email", "nexus@example.test")
	runGitCommand(t, client, "config", "user.name", "Nexus Test")

	return remote, client
}
