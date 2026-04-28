package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseStatusExtractsBranchAheadBehindAndFileEntries(t *testing.T) {
	summary := ParseStatus("## main...origin/main [ahead 2, behind 1]\n M src/app.ts\nA  src/staged.ts\nR  old.txt -> new.txt\n?? scratch.txt\n")

	if summary.Branch == nil || *summary.Branch != "main" {
		t.Fatalf("branch = %v, want main", summary.Branch)
	}
	if summary.Upstream == nil || *summary.Upstream != "origin/main" {
		t.Fatalf("upstream = %v, want origin/main", summary.Upstream)
	}
	if summary.Ahead != 2 || summary.Behind != 1 {
		t.Fatalf("ahead/behind = %d/%d, want 2/1", summary.Ahead, summary.Behind)
	}
	if got := len(summary.Files); got != 4 {
		t.Fatalf("files len = %d, want 4: %#v", got, summary.Files)
	}

	renamed := summary.Files[0]
	if renamed.Path != "new.txt" || renamed.OriginalPath == nil || *renamed.OriginalPath != "old.txt" || renamed.Kind != "renamed" {
		t.Fatalf("renamed entry = %+v", renamed)
	}
}

func TestParseBranchesSortsCurrentBranchFirst(t *testing.T) {
	branches := ParseBranches("feature\t \torigin/feature\tabc123\nmain\t*\torigin/main\tdef456\n")

	if len(branches) != 2 {
		t.Fatalf("branches len = %d, want 2", len(branches))
	}
	if branches[0].Name != "main" || !branches[0].Current {
		t.Fatalf("first branch = %+v, want current main", branches[0])
	}
	if branches[1].Upstream == nil || *branches[1].Upstream != "origin/feature" {
		t.Fatalf("feature upstream = %v", branches[1].Upstream)
	}
}

func TestCLIUsesArgumentArraysForSupportedCommands(t *testing.T) {
	runner := &recordingRunner{}
	cli := NewCLIWithRunner("git-test", runner)
	ctx := context.Background()
	cwd := "/workspace"

	if _, err := cli.Status(ctx, cwd); err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if _, err := cli.BranchList(ctx, cwd); err != nil {
		t.Fatalf("BranchList() error = %v", err)
	}
	if err := cli.Stage(ctx, cwd, []string{"src/app.ts"}); err != nil {
		t.Fatalf("Stage() error = %v", err)
	}
	if err := cli.Unstage(ctx, cwd, []string{"src/app.ts"}); err != nil {
		t.Fatalf("Unstage() error = %v", err)
	}
	if err := cli.Discard(ctx, cwd, []string{"scratch.txt"}); err != nil {
		t.Fatalf("Discard() error = %v", err)
	}
	if err := cli.Checkout(ctx, cwd, "feature"); err != nil {
		t.Fatalf("Checkout() error = %v", err)
	}
	startPoint := "main"
	if err := cli.BranchCreate(ctx, cwd, "feature", &startPoint); err != nil {
		t.Fatalf("BranchCreate() error = %v", err)
	}
	if err := cli.BranchDelete(ctx, cwd, "feature", true); err != nil {
		t.Fatalf("BranchDelete() error = %v", err)
	}
	if _, err := cli.Diff(ctx, cwd, true, []string{"src/app.ts"}); err != nil {
		t.Fatalf("Diff() error = %v", err)
	}
	if _, err := cli.Commit(ctx, cwd, "message", false); err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if _, err := cli.Commit(ctx, cwd, "amended", true); err != nil {
		t.Fatalf("Commit(amend) error = %v", err)
	}

	want := [][]string{
		{"status", "--porcelain=v1", "-b", "--untracked-files=all"},
		{"branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(objectname)"},
		{"add", "--", "src/app.ts"},
		{"restore", "--staged", "--", "src/app.ts"},
		{"restore", "--staged", "--worktree", "--", "scratch.txt"},
		{"clean", "-fd", "--", "scratch.txt"},
		{"checkout", "feature"},
		{"branch", "feature", "main"},
		{"branch", "-D", "feature"},
		{"diff", "--no-ext-diff", "--cached", "--", "src/app.ts"},
		{"commit", "-m", "message"},
		{"rev-parse", "HEAD"},
		{"commit", "-m", "amended", "--amend"},
		{"rev-parse", "HEAD"},
	}
	if !reflect.DeepEqual(runner.args, want) {
		t.Fatalf("args mismatch:\nwant %#v\n got %#v", want, runner.args)
	}
	for _, gitPath := range runner.gitPaths {
		if gitPath != "git-test" {
			t.Fatalf("git path = %q, want git-test", gitPath)
		}
	}
	for _, gotCwd := range runner.cwd {
		if gotCwd != cwd {
			t.Fatalf("cwd = %q, want %q", gotCwd, cwd)
		}
	}
}

func TestCLIRejectsEmptyPathCommands(t *testing.T) {
	cli := NewCLIWithRunner("git", &recordingRunner{})
	if err := cli.Stage(context.Background(), "/workspace", nil); !errors.Is(err, ErrNoPaths) {
		t.Fatalf("Stage(nil) error = %v, want ErrNoPaths", err)
	}
}

func TestCLISmokeAgainstTempGitRepository(t *testing.T) {
	requireGitBinary(t)
	ctx := context.Background()
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "nexus@example.invalid")
	runGitCommand(t, repo, "config", "user.name", "Nexus Test")

	cli := NewCLI()
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cli.Stage(ctx, repo, []string{"README.md"}); err != nil {
		t.Fatalf("Stage() initial error = %v", err)
	}
	oid, err := cli.Commit(ctx, repo, "initial", false)
	if err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if strings.TrimSpace(oid) == "" {
		t.Fatal("Commit() oid is empty")
	}

	branches, err := cli.BranchList(ctx, repo)
	if err != nil {
		t.Fatalf("BranchList() error = %v", err)
	}
	currentBranch := ""
	for _, branch := range branches {
		if branch.Current {
			currentBranch = branch.Name
			break
		}
	}
	if currentBranch == "" {
		t.Fatalf("branches = %+v, want current branch", branches)
	}

	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\nchanged\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	summary, err := cli.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if len(summary.Files) != 1 || summary.Files[0].Kind != "modified" {
		t.Fatalf("status summary = %+v, want one modified file", summary)
	}
	diff, err := cli.Diff(ctx, repo, false, []string{"README.md"})
	if err != nil {
		t.Fatalf("Diff() error = %v", err)
	}
	if !strings.Contains(diff, "+changed") {
		t.Fatalf("diff = %q, want added line", diff)
	}
	if err := cli.Stage(ctx, repo, []string{"README.md"}); err != nil {
		t.Fatalf("Stage() modified error = %v", err)
	}
	if err := cli.Unstage(ctx, repo, []string{"README.md"}); err != nil {
		t.Fatalf("Unstage() error = %v", err)
	}
	if err := cli.Discard(ctx, repo, []string{"README.md"}); err != nil {
		t.Fatalf("Discard() error = %v", err)
	}
	summary, err = cli.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status() after discard error = %v", err)
	}
	if len(summary.Files) != 0 {
		t.Fatalf("status after discard = %+v, want clean", summary)
	}

	if err := cli.BranchCreate(ctx, repo, "feature/test", nil); err != nil {
		t.Fatalf("BranchCreate() error = %v", err)
	}
	if err := cli.Checkout(ctx, repo, "feature/test"); err != nil {
		t.Fatalf("Checkout(feature) error = %v", err)
	}
	if err := cli.Checkout(ctx, repo, currentBranch); err != nil {
		t.Fatalf("Checkout(%s) error = %v", currentBranch, err)
	}
	if err := cli.BranchDelete(ctx, repo, "feature/test", true); err != nil {
		t.Fatalf("BranchDelete() error = %v", err)
	}
}

type recordingRunner struct {
	gitPaths []string
	cwd      []string
	args     [][]string
}

func (r *recordingRunner) Run(_ context.Context, cwd string, gitPath string, args []string) (CommandResult, error) {
	r.gitPaths = append(r.gitPaths, gitPath)
	r.cwd = append(r.cwd, cwd)
	r.args = append(r.args, append([]string(nil), args...))
	switch {
	case len(args) >= 1 && args[0] == "status":
		return CommandResult{Stdout: "## main\n"}, nil
	case len(args) >= 1 && args[0] == "branch":
		return CommandResult{Stdout: "main\t*\t\tabc123\n"}, nil
	case reflect.DeepEqual(args, []string{"rev-parse", "HEAD"}):
		return CommandResult{Stdout: "abc123\n"}, nil
	default:
		return CommandResult{}, nil
	}
}

func requireGitBinary(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not available on PATH: %v", err)
	}
}

func runGitCommand(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}
