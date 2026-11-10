package git

import (
	"context"
	"encoding/json"
	"testing"
)

// ---------------------------------------------------------------------------
// Integration tests using real temp git repos
// ---------------------------------------------------------------------------

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
