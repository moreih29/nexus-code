package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

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
	t.Parallel()
	service := New(t.TempDir())
	_, err := service.WorkflowMerge(context.Background(), json.RawMessage(`{"cwd":"","branch":""}`))
	if !isProtocolError(err) {
		t.Fatalf("WorkflowMerge with empty branch error = %v, want a protocol error", err)
	}
}

// TestWorkflowMergeClean verifies a clean merge returns result:"clean".
func TestWorkflowMergeClean(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	runGit(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGit(t, root, "add", "feature.txt")
	runGit(t, root, "commit", "-m", "feature")
	runGit(t, root, "checkout", "main")

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
	t.Parallel()
	root := newConflictRepo(t)
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
	t.Parallel()
	root := newConflictRepo(t)
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
	t.Parallel()
	root := newRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root})
	_, err := service.WorkflowAbort(context.Background(), raw)
	if err == nil {
		t.Fatal("WorkflowAbort with no operation should return error")
	}
}

// TestWorkflowAbortMerge verifies abort of an in-progress merge.
func TestWorkflowAbortMerge(t *testing.T) {
	t.Parallel()
	root := newConflictRepo(t)
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
	t.Parallel()
	root := newRepo(t)
	service := New(root)
	raw, _ := json.Marshal(map[string]string{"cwd": root})
	_, err := service.WorkflowContinue(context.Background(), raw)
	if err == nil {
		t.Fatal("WorkflowContinue with no operation should return error")
	}
}

// TestWorkflowRebaseClean verifies a clean rebase returns result:"clean".
func TestWorkflowRebaseClean(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	runGit(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGit(t, root, "add", "feature.txt")
	runGit(t, root, "commit", "-m", "feature")
	runGit(t, root, "checkout", "main")
	writeFile(t, filepath.Join(root, "main2.txt"), "main2\n")
	runGit(t, root, "add", "main2.txt")
	runGit(t, root, "commit", "-m", "main2")
	runGit(t, root, "checkout", "feature")

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
	t.Parallel()
	root := newRepo(t)
	runGit(t, root, "checkout", "-b", "feature")
	writeFile(t, filepath.Join(root, "picked.txt"), "picked\n")
	runGit(t, root, "add", "picked.txt")
	runGit(t, root, "commit", "-m", "picked")

	sha := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	runGit(t, root, "checkout", "main")

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
