package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Pull tests
// ---------------------------------------------------------------------------

// TestPullAlreadyUpToDate verifies that pull returns alreadyUpToDate when nothing to pull.
func TestPullAlreadyUpToDate(t *testing.T) {
	t.Parallel()
	_, client := newRemoteAndClient(t, false)

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
	t.Parallel()
	_, client := newRemoteAndClient(t, true)

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
	t.Parallel()
	root := newRepo(t)

	service := New(root)
	_, err := service.Pull(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected Pull to fail with no upstream configured")
	}
}

// TestPullMergesDivergedBranch verifies that pull reconciles a branch that
// has diverged from its upstream with a merge when no pull.ff or pull.rebase
// is configured, instead of failing as plain git pull does since 2.33.
func TestPullMergesDivergedBranch(t *testing.T) {
	t.Parallel()
	client := makeDivergedClient(t)

	service := New(client)
	if _, err := service.Pull(context.Background(), json.RawMessage(`{}`)); err != nil {
		t.Fatalf("Pull returned error: %v", err)
	}

	parents := strings.Fields(runGit(t, client, "rev-list", "--parents", "-n", "1", "HEAD"))
	if len(parents) != 3 {
		t.Errorf("expected a merge commit with 2 parents, got %v", parents)
	}
}

// TestPullHonorsPullRebase verifies that the merge default does not override
// a configured pull.rebase.
func TestPullHonorsPullRebase(t *testing.T) {
	t.Parallel()
	client := makeDivergedClient(t)
	runGit(t, client, "config", "pull.rebase", "true")

	service := New(client)
	if _, err := service.Pull(context.Background(), json.RawMessage(`{}`)); err != nil {
		t.Fatalf("Pull returned error: %v", err)
	}

	parents := strings.Fields(runGit(t, client, "rev-list", "--parents", "-n", "1", "HEAD"))
	if len(parents) != 2 {
		t.Errorf("expected the local commit rebased onto the remote one, got parents %v", parents)
	}
	if count := strings.TrimSpace(runGit(t, client, "rev-list", "--count", "HEAD")); count != "3" {
		t.Errorf("expected 3 commits in a line, got %s", count)
	}
}

// TestPullHonorsPullFFOnly verifies that a configured pull.ff=only still
// refuses to reconcile a diverged branch.
func TestPullHonorsPullFFOnly(t *testing.T) {
	t.Parallel()
	client := makeDivergedClient(t)
	runGit(t, client, "config", "pull.ff", "only")

	service := New(client)
	if _, err := service.Pull(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected Pull to fail on a diverged branch with pull.ff=only")
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
	t.Parallel()
	_, client := newRemoteAndClient(t, false)

	// Make a local commit to push.
	writeFile(t, filepath.Join(client, "new.txt"), "new\n")
	runGit(t, client, "add", "new.txt")
	runGit(t, client, "commit", "-m", "new commit")

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
	t.Parallel()
	_, client := newRemoteAndClient(t, false)

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
	t.Parallel()
	client := makeDivergedClient(t)

	service := New(client)
	_, err := service.Push(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected Push to fail for non-fast-forward")
	}
	// The error frame carries the kind and hint the host's retry banner needs.
	line, err := proto.MarshalFrame(proto.ErrorResponse("1", err))
	if err != nil {
		t.Fatalf("MarshalFrame() error = %v", err)
	}
	var frame struct {
		Error struct {
			Code string `json:"code"`
			Data struct {
				ErrorKind string      `json:"errorKind"`
				ErrorHint *ActionHint `json:"errorHint"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &frame); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if frame.Error.Code != proto.CodeRequestFailed || frame.Error.Data.ErrorKind != string(KindNonFastForward) {
		t.Fatalf("error frame = %s, want request-failed with kind non-fast-forward", line)
	}
	if frame.Error.Data.ErrorHint == nil || frame.Error.Data.ErrorHint.Kind != "pull-then-retry" {
		t.Fatalf("error frame = %s, want the pull-then-retry hint", line)
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

// makeDivergedClient returns a client clone that has one local commit while
// its remote has gained a different one, so the two have diverged.
func makeDivergedClient(t *testing.T) string {
	t.Helper()
	_, client := newRemoteAndClient(t, true)
	writeFile(t, filepath.Join(client, "local.txt"), "local\n")
	runGit(t, client, "add", "local.txt")
	runGit(t, client, "commit", "-m", "local commit")
	return client
}
