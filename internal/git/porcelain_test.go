package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestParsePorcelainV2StatusFixtures verifies every manually authored status
// fixture against the pure parser. Service-owned fields are normalized because
// they come from separate host-local subcalls, not porcelain stdout.
func TestParsePorcelainV2StatusFixtures(t *testing.T) {
	fixtureRoot := statusFixtureRoot(t)
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read status fixtures: %v", err)
	}

	loaded := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(fixtureRoot, name)
		stdout, err := os.ReadFile(filepath.Join(dir, "stdout.bin"))
		if err != nil {
			t.Fatalf("%s: read stdout.bin: %v", name, err)
		}
		expectedBytes, err := os.ReadFile(filepath.Join(dir, "expected.json"))
		if err != nil {
			t.Fatalf("%s: read expected.json: %v", name, err)
		}
		var expected GitStatus
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}
		expected = normalizeExpectedForPorcelain(expected)

		got, err := ParsePorcelainV2(stdout)
		if err != nil {
			t.Fatalf("%s: ParsePorcelainV2: %v", name, err)
		}
		assertEqualJSON(t, name, got, expected)
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no status fixtures loaded")
	}
	t.Logf("loaded %d status fixtures", loaded)
}

func TestParsePorcelainV2RejectsMissingNulRenameOldPath(t *testing.T) {
	_, err := ParsePorcelainV2([]byte("2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new.txt\x00"))
	if err == nil {
		t.Fatal("expected missing old path error")
	}
}

func TestStatusServiceTempRepoShape(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "tracked.txt"), "base\n")
	runGitCommand(t, root, "add", "tracked.txt")
	runGitCommand(t, root, "commit", "-m", "initial")
	writeFile(t, filepath.Join(root, "tracked.txt"), "changed\n")
	writeFile(t, filepath.Join(root, "untracked.txt"), "new\n")

	service := New(root)
	res, err := service.Status(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	status, ok := res.(GitStatus)
	if !ok {
		t.Fatalf("Status result type = %T", res)
	}
	if status.Branch == nil || status.Branch.Current != "main" || status.Branch.IsUnborn {
		t.Fatalf("unexpected branch: %#v", status.Branch)
	}
	if !status.Capabilities.HasHEAD {
		t.Fatal("capabilities.hasHEAD = false, want true")
	}
	if len(status.Working) != 1 || status.Working[0].RelPath != "tracked.txt" || status.Working[0].XY != ".M" {
		t.Fatalf("working mismatch: %#v", status.Working)
	}
	if len(status.Untracked) != 1 || status.Untracked[0].RelPath != "untracked.txt" {
		t.Fatalf("untracked mismatch: %#v", status.Untracked)
	}
	if got := status.OperationState["kind"]; got != "none" {
		t.Fatalf("operationState.kind got %#v want none", got)
	}
	if status.LastFetchedAt != nil {
		t.Fatalf("lastFetchedAt got %v want nil", *status.LastFetchedAt)
	}
}

func TestStatusRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")

	d := dispatch.New()
	Register(d, New(root))
	res := d.Dispatch(context.Background(), proto.Request{ID: "git.status", Method: "git.status", Params: json.RawMessage(`{}`)})
	if res.Error != nil {
		t.Fatalf("git.status dispatch returned error: %#v", res.Error)
	}
	if _, ok := res.Result.(GitStatus); !ok {
		t.Fatalf("git.status result type = %T", res.Result)
	}
}

func normalizeExpectedForPorcelain(status GitStatus) GitStatus {
	status.Capabilities.Remotes = []string{}
	status.Capabilities.StashCount = 0
	status.Capabilities.TagCount = 0
	status.OperationState = map[string]any{"kind": "none"}
	status.LastFetchedAt = nil
	return status
}

func assertEqualJSON(t *testing.T, name string, got GitStatus, expected GitStatus) {
	t.Helper()
	gotJSON := canonicalJSON(t, got)
	expectedJSON := canonicalJSON(t, expected)
	if gotJSON != expectedJSON {
		t.Fatalf("%s:\ngot  %s\nwant %s", name, gotJSON, expectedJSON)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("%s: struct got %#v want %#v", name, got, expected)
	}
}

func canonicalJSON(t *testing.T, value any) string {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("unmarshal canonical: %v", err)
	}
	normalizeJSON(decoded)
	bytes, err = json.Marshal(decoded)
	if err != nil {
		t.Fatalf("marshal canonical: %v", err)
	}
	return string(bytes)
}

func normalizeJSON(value any) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			normalizeJSON(typed[key])
		}
	case []any:
		for _, item := range typed {
			normalizeJSON(item)
		}
	}
}

func statusFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "status"))
}

func runGitCommand(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
