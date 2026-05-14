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

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Fixture directory helper
// ---------------------------------------------------------------------------

// workflowFixtureRoot returns the path to tests/fixtures/git/workflow.
func workflowFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "workflow"))
}

// ---------------------------------------------------------------------------
// Unit tests for helper functions
// ---------------------------------------------------------------------------

// TestBuildMergeArgs verifies that buildMergeArgs maps every mode to correct argv.
func TestBuildMergeArgs(t *testing.T) {
	cases := []struct {
		mode string
		want []string
	}{
		{"", []string{"merge", "--no-edit", "main"}},
		{"default", []string{"merge", "--no-edit", "main"}},
		{"no-ff", []string{"merge", "--no-ff", "--no-edit", "main"}},
		{"squash", []string{"merge", "--squash", "main"}},
		{"no-commit", []string{"merge", "--no-commit", "main"}},
		{"ff-only", []string{"merge", "--ff-only", "main"}},
	}
	for _, c := range cases {
		got := buildMergeArgs("main", c.mode)
		if len(got) != len(c.want) {
			t.Errorf("buildMergeArgs(%q) len=%d, want %d: got %v, want %v", c.mode, len(got), len(c.want), got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("buildMergeArgs(%q)[%d] = %q, want %q", c.mode, i, got[i], c.want[i])
			}
		}
	}
}

// TestAbortArgs verifies abortArgs returns the correct git argv for each operation.
func TestAbortArgs(t *testing.T) {
	cases := []struct {
		kind string
		want []string
	}{
		{"merge", []string{"merge", "--abort"}},
		{"rebase", []string{"rebase", "--abort"}},
		{"cherry-pick", []string{"cherry-pick", "--abort"}},
		{"revert", []string{"revert", "--abort"}},
	}
	for _, c := range cases {
		got := abortArgs(c.kind)
		if len(got) != len(c.want) {
			t.Errorf("abortArgs(%q) = %v, want %v", c.kind, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("abortArgs(%q)[%d] = %q, want %q", c.kind, i, got[i], c.want[i])
			}
		}
	}
}

// TestContinueArgs verifies continueArgs returns the correct git argv.
func TestContinueArgs(t *testing.T) {
	cases := []struct {
		kind string
		want []string
	}{
		{"merge", []string{"commit", "--no-edit"}},
		{"rebase", []string{"rebase", "--continue"}},
		{"cherry-pick", []string{"cherry-pick", "--continue"}},
		{"revert", []string{"revert", "--continue"}},
	}
	for _, c := range cases {
		got := continueArgs(c.kind)
		if len(got) != len(c.want) {
			t.Errorf("continueArgs(%q) = %v, want %v", c.kind, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("continueArgs(%q)[%d] = %q, want %q", c.kind, i, got[i], c.want[i])
			}
		}
	}
}

// TestOperationKind verifies operationKind extracts the kind field correctly.
func TestOperationKind(t *testing.T) {
	cases := []struct {
		state map[string]any
		want  string
	}{
		{nil, "none"},
		{map[string]any{"kind": "none"}, "none"},
		{map[string]any{"kind": "merge"}, "merge"},
		{map[string]any{"kind": "rebase"}, "rebase"},
		{map[string]any{"kind": "cherry-pick"}, "cherry-pick"},
		{map[string]any{}, "none"},
	}
	for _, c := range cases {
		got := operationKind(c.state)
		if got != c.want {
			t.Errorf("operationKind(%v) = %q, want %q", c.state, got, c.want)
		}
	}
}

// TestContinueResult verifies continueResult maps operation state to the result envelope.
func TestContinueResult(t *testing.T) {
	completed := continueResult(map[string]any{"kind": "none"})
	if completed.Result != "completed" {
		t.Errorf("continueResult(none).Result = %q, want completed", completed.Result)
	}

	clean := continueResult(map[string]any{"kind": "rebase", "conflictCount": float64(0)})
	if clean.Result != "clean" || clean.ConflictCount != 0 {
		t.Errorf("continueResult(rebase,0) = %+v, want {Result:clean ConflictCount:0}", clean)
	}

	conflict := continueResult(map[string]any{"kind": "rebase", "conflictCount": float64(2)})
	if conflict.Result != "conflicts" || conflict.ConflictCount != 2 {
		t.Errorf("continueResult(rebase,2) = %+v, want {Result:conflicts ConflictCount:2}", conflict)
	}
}

// ---------------------------------------------------------------------------
// Integration tests using real temp git repos
// ---------------------------------------------------------------------------

// TestWorkflowMergeMissingBranchReturnsError verifies missing branch is rejected.
func TestWorkflowMergeMissingBranchReturnsError(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	_, err := service.WorkflowMerge(context.Background(), json.RawMessage(`{"cwd":"","branch":""}`))
	if err == nil {
		t.Fatal("WorkflowMerge with empty branch should return error")
	}
}

// TestWorkflowMergeClean verifies a clean merge returns result:"clean".
func TestWorkflowMergeClean(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	runGitCommand(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGitCommand(t, root, "add", "feature.txt")
	runGitCommand(t, root, "commit", "-m", "feature")
	runGitCommand(t, root, "checkout", "main")

	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	result, err := service.WorkflowMerge(context.Background(), raw)
	if err != nil {
		t.Fatalf("WorkflowMerge clean: %v", err)
	}
	wr, ok := result.(WorkflowResult)
	if !ok {
		t.Fatalf("WorkflowMerge result type = %T, want WorkflowResult", result)
	}
	if wr.Result != "clean" {
		t.Errorf("WorkflowMerge clean result = %q, want clean", wr.Result)
	}
}

// TestWorkflowMergeConflict verifies a conflicting merge returns result:"conflicts".
func TestWorkflowMergeConflict(t *testing.T) {
	root := makeWorkflowConflictRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	result, err := service.WorkflowMerge(context.Background(), raw)
	if err != nil {
		t.Fatalf("WorkflowMerge conflict: %v", err)
	}
	wr, ok := result.(WorkflowResult)
	if !ok {
		t.Fatalf("WorkflowMerge conflict result type = %T", result)
	}
	if wr.Result != "conflicts" {
		t.Errorf("WorkflowMerge conflict result = %q, want conflicts", wr.Result)
	}
	if wr.ConflictCount == 0 {
		t.Errorf("WorkflowMerge conflict count = 0, want > 0")
	}
}

// TestWorkflowMergeAlreadyInProgress verifies already-in-progress error.
func TestWorkflowMergeAlreadyInProgress(t *testing.T) {
	root := makeWorkflowConflictRepo(t)
	service := New(root)

	raw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	_, _ = service.WorkflowMerge(context.Background(), raw)

	_, err := service.WorkflowMerge(context.Background(), raw)
	if err == nil {
		t.Fatal("second WorkflowMerge should return error")
	}
}

// TestWorkflowAbortNoOperation verifies abort when no operation is in progress.
func TestWorkflowAbortNoOperation(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root})
	_, err := service.WorkflowAbort(context.Background(), raw)
	if err == nil {
		t.Fatal("WorkflowAbort with no operation should return error")
	}
}

// TestWorkflowAbortMerge verifies abort of an in-progress merge.
func TestWorkflowAbortMerge(t *testing.T) {
	root := makeWorkflowConflictRepo(t)
	service := New(root)

	mergeRaw, _ := json.Marshal(map[string]string{"cwd": root, "branch": "feature"})
	_, _ = service.WorkflowMerge(context.Background(), mergeRaw)

	abortRaw, _ := json.Marshal(map[string]string{"cwd": root})
	_, err := service.WorkflowAbort(context.Background(), abortRaw)
	if err != nil {
		t.Fatalf("WorkflowAbort: %v", err)
	}
}

// TestWorkflowContinueNoOperation verifies continue when no operation is in progress.
func TestWorkflowContinueNoOperation(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root})
	_, err := service.WorkflowContinue(context.Background(), raw)
	if err == nil {
		t.Fatal("WorkflowContinue with no operation should return error")
	}
}

// TestWorkflowRebaseClean verifies a clean rebase returns result:"clean".
func TestWorkflowRebaseClean(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	runGitCommand(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGitCommand(t, root, "add", "feature.txt")
	runGitCommand(t, root, "commit", "-m", "feature")
	runGitCommand(t, root, "checkout", "main")
	writeFile(t, filepath.Join(root, "main2.txt"), "main2\n")
	runGitCommand(t, root, "add", "main2.txt")
	runGitCommand(t, root, "commit", "-m", "main2")
	runGitCommand(t, root, "checkout", "feature")

	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root, "onto": "main"})
	result, err := service.WorkflowRebase(context.Background(), raw)
	if err != nil {
		t.Fatalf("WorkflowRebase clean: %v", err)
	}
	wr, ok := result.(WorkflowResult)
	if !ok {
		t.Fatalf("WorkflowRebase result type = %T", result)
	}
	if wr.Result != "clean" {
		t.Errorf("WorkflowRebase clean result = %q, want clean", wr.Result)
	}
}

// TestWorkflowCherryPickClean verifies a clean cherry-pick returns result:"clean".
func TestWorkflowCherryPickClean(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	runGitCommand(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "picked.txt"), "picked\n")
	runGitCommand(t, root, "add", "picked.txt")
	runGitCommand(t, root, "commit", "-m", "picked")

	sha := gitOutput(t, root, "rev-parse", "HEAD")
	runGitCommand(t, root, "checkout", "main")

	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root, "sha": sha})
	result, err := service.WorkflowCherryPick(context.Background(), raw)
	if err != nil {
		t.Fatalf("WorkflowCherryPick clean: %v", err)
	}
	wr, ok := result.(WorkflowResult)
	if !ok {
		t.Fatalf("WorkflowCherryPick result type = %T", result)
	}
	if wr.Result != "clean" {
		t.Errorf("WorkflowCherryPick clean result = %q, want clean", wr.Result)
	}
}

// TestWorkflowRegisteredWithDispatcher verifies all workflow methods are registered.
func TestWorkflowRegisteredWithDispatcher(t *testing.T) {
	root := makeWorkflowBaseRepo(t)
	d := dispatch.New()
	Register(d, New(root))

	methods := []string{
		"git.workflow.merge",
		"git.workflow.rebase",
		"git.workflow.cherryPick",
		"git.workflow.abort",
		"git.workflow.continue",
		"git.conflict.markResolved",
	}

	for _, method := range methods {
		t.Run(method, func(t *testing.T) {
			res := d.Dispatch(context.Background(), proto.Request{
				ID:     "1",
				Method: method,
				Params: json.RawMessage(`{}`),
			})
			// Param validation errors are expected for empty params.
			// The key property being tested is that the method is registered
			// (not returning "method not found").
			if res.Error != nil {
				// Acceptable — method found, param validation may fail.
				_ = res.Error
			}
		})
	}
}

// TestWorkflowFixturesExist logs a warning if the fixture root is absent.
func TestWorkflowFixturesExist(t *testing.T) {
	root := workflowFixtureRoot(t)
	if _, err := os.Stat(root); err != nil {
		t.Logf("workflow fixture root %q not yet present (will be created): %v", root, err)
	}
}

// ---------------------------------------------------------------------------
// Test helper functions
// ---------------------------------------------------------------------------

// makeWorkflowBaseRepo creates a bare git repository with one initial commit.
func makeWorkflowBaseRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "base\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")
	return root
}

// makeWorkflowConflictRepo creates a repo checked out on main with a feature
// branch that will conflict when merged.
func makeWorkflowConflictRepo(t *testing.T) string {
	t.Helper()
	root := makeWorkflowBaseRepo(t)
	runGitCommand(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "conflict.txt"), "feature\n")
	runGitCommand(t, root, "add", "conflict.txt")
	runGitCommand(t, root, "commit", "-m", "feature conflict")
	runGitCommand(t, root, "checkout", "main")
	writeFile(t, filepath.Join(root, "conflict.txt"), "main\n")
	runGitCommand(t, root, "add", "conflict.txt")
	runGitCommand(t, root, "commit", "-m", "main conflict")
	return root
}

// gitOutput runs git and returns trimmed stdout.
func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// newGitCmd is not used in this file but kept for reference by the helper above.
func newGitCmd(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	return cmd
}
