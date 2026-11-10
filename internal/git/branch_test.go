package git

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// TestBranchDeleteUnmerged verifies that BranchDelete returns force-delete hint for unmerged branch.
func TestBranchDeleteUnmerged(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

	// Create unmerged branch with a commit.
	runGit(t, root, "checkout", "-b", "unmerged")
	writeFile(t, filepath.Join(root, "topic.txt"), "topic\n")
	runGit(t, root, "add", "topic.txt")
	runGit(t, root, "commit", "-m", "topic commit")
	runGit(t, root, "checkout", "main")

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

// TestBranchFastForwardClean verifies BranchFastForward advances the branch.
func TestBranchFastForwardClean(t *testing.T) {
	t.Parallel()
	_, client := newRemoteAndClient(t, true)

	fromSha := strings.TrimSpace(runGit(t, client, "rev-parse", "HEAD"))

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
