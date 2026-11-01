package git

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// TestRemoteAddServiceTempRepo verifies RemoteAdd adds a remote to a repository.
func TestRemoteAddServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

	service := New(root)
	_, err := service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/repo.git"}`))
	if err != nil {
		t.Fatalf("RemoteAdd returned error: %v", err)
	}

	// Verify via git remote list.
	out := runGit(t, root, "remote")
	if strings.TrimSpace(out) != "origin" {
		t.Errorf("git remote after add = %q, want \"origin\"", strings.TrimSpace(out))
	}
}

// TestRemoteAddDuplicateName verifies duplicate remote name surfaces as remote-exists.
func TestRemoteAddDuplicateName(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

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
	t.Parallel()
	root := newRepo(t)

	service := New(root)
	_, _ = service.RemoteAdd(context.Background(), json.RawMessage(`{"name":"origin","url":"https://example.invalid/repo.git"}`))
	_, err := service.RemoteRemove(context.Background(), json.RawMessage(`{"name":"origin"}`))
	if err != nil {
		t.Fatalf("RemoteRemove returned error: %v", err)
	}

	out := runGit(t, root, "remote")
	if strings.TrimSpace(out) != "" {
		t.Errorf("git remote after remove = %q, want empty", strings.TrimSpace(out))
	}
}

// TestRemoteRemoveNotFound verifies non-existent remote surfaces as remote-not-found.
func TestRemoteRemoveNotFound(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

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
