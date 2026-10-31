package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// stashListExpected mirrors the fixture expected.json for git.stash.list.
type stashListExpected struct {
	Method string          `json:"method"`
	Case   string          `json:"case"`
	Params StashListParams `json:"params"`
	Result []StashEntry    `json:"result"`
}

// TestStashListFixtures verifies every stash list fixture against parseStashList.
func TestStashListFixtures(t *testing.T) {
	fixtureRoot := fixtureDir("stash")
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read stash fixtures: %v", err)
	}

	loaded := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "list-") {
			continue
		}
		dir := filepath.Join(fixtureRoot, name)
		stdout, err := os.ReadFile(filepath.Join(dir, "stdout.bin"))
		if err != nil {
			t.Fatalf("%s: read stdout.bin: %v", name, err)
		}
		expectedBytes, err := os.ReadFile(filepath.Join(dir, "expected.json"))
		if err != nil {
			t.Fatalf("%s: read expected.json: %v", name, err)
		}
		var expected stashListExpected
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		got := parseStashList(string(stdout))
		assertStashListEqual(t, name, got, expected.Result)
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no stash list fixtures loaded")
	}
	t.Logf("loaded %d stash list fixtures", loaded)
}

// TestStashListServiceTempRepo verifies StashList against a real git repository.
func TestStashListServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

	// Create one stash entry.
	writeFile(t, filepath.Join(root, "README.md"), "changed\n")
	runGit(t, root, "stash", "push", "-m", "test stash entry")

	service := New(root)
	res, err := service.StashList(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("StashList returned error: %v", err)
	}
	list, ok := res.([]StashEntry)
	if !ok {
		t.Fatalf("StashList result type = %T", res)
	}
	if len(list) != 1 {
		t.Fatalf("StashList got %d entries, want 1", len(list))
	}
	if list[0].Index != 0 {
		t.Fatalf("StashList entry[0].Index = %d, want 0", list[0].Index)
	}
	if list[0].Message != "test stash entry" {
		t.Fatalf("StashList entry[0].Message = %q, want %q", list[0].Message, "test stash entry")
	}
	if list[0].Branch != "main" {
		t.Fatalf("StashList entry[0].Branch = %q, want main", list[0].Branch)
	}
	if list[0].SHA == "" {
		t.Fatalf("StashList entry[0].SHA is empty")
	}
	if list[0].CreatedAt <= 0 {
		t.Fatalf("StashList entry[0].CreatedAt = %d, want > 0", list[0].CreatedAt)
	}
}

// TestStashApplyConflictServiceTempRepo verifies StashApply returns a conflict result.
func TestStashApplyConflictServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

	// Stash a change.
	writeFile(t, filepath.Join(root, "README.md"), "stashed line\n")
	runGit(t, root, "stash", "push")

	// Create a conflicting commit.
	writeFile(t, filepath.Join(root, "README.md"), "head line\n")
	runGit(t, root, "add", "README.md")
	runGit(t, root, "commit", "-m", "conflicting head")

	service := New(root)
	res, err := service.StashApply(context.Background(), json.RawMessage(`{"index":0}`))
	if err != nil {
		t.Fatalf("StashApply returned transport error: %v", err)
	}
	result, ok := res.(StashApplyResult)
	if !ok {
		t.Fatalf("StashApply result type = %T, want StashApplyResult", res)
	}
	if result.ErrorKind == "" {
		t.Fatalf("StashApply expected conflict error, got clean result")
	}
	if result.ErrorKind != KindStashConflict && result.ErrorKind != KindConflict {
		t.Fatalf("StashApply errorKind = %q, want stash-conflict", result.ErrorKind)
	}
}

// TestStashApplyCleanServiceTempRepo verifies StashApply succeeds with empty result.
func TestStashApplyCleanServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)

	writeFile(t, filepath.Join(root, "README.md"), "changed\n")
	runGit(t, root, "stash", "push")

	service := New(root)
	res, err := service.StashApply(context.Background(), json.RawMessage(`{"index":0}`))
	if err != nil {
		t.Fatalf("StashApply returned error: %v", err)
	}
	result, ok := res.(StashApplyResult)
	if !ok {
		t.Fatalf("StashApply result type = %T, want StashApplyResult", res)
	}
	if result.ErrorKind != "" {
		t.Fatalf("StashApply expected clean result, got errorKind=%q", result.ErrorKind)
	}
}

// TestStashDropServiceTempRepo verifies StashDrop removes the stash entry.
func TestStashDropServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	writeFile(t, filepath.Join(root, "README.md"), "changed\n")
	runGit(t, root, "stash", "push")

	service := New(root)
	_, err := service.StashDrop(context.Background(), json.RawMessage(`{"index":0}`))
	if err != nil {
		t.Fatalf("StashDrop returned error: %v", err)
	}

	// Verify stash list is now empty.
	res, err := service.StashList(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("StashList after drop returned error: %v", err)
	}
	list := res.([]StashEntry)
	if len(list) != 0 {
		t.Fatalf("StashList after drop: got %d entries, want 0", len(list))
	}
}

// TestStashGroupServiceTempRepo verifies StashGroup stashes selected paths.
func TestStashGroupServiceTempRepo(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	// Git for Windows checks text out with CRLF by default.
	runGit(t, root, "config", "core.autocrlf", "false")
	writeFile(t, filepath.Join(root, "a.txt"), "base-a\n")
	writeFile(t, filepath.Join(root, "b.txt"), "base-b\n")
	runGit(t, root, "add", ".")
	runGit(t, root, "commit", "-m", "a and b")

	writeFile(t, filepath.Join(root, "a.txt"), "changed-a\n")
	writeFile(t, filepath.Join(root, "b.txt"), "changed-b\n")

	params := `{"message":"group a only","paths":["a.txt"]}`
	service := New(root)
	_, err := service.StashGroup(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("StashGroup returned error: %v", err)
	}

	// b.txt should still be changed, a.txt should be restored.
	aContent := readFile(t, filepath.Join(root, "a.txt"))
	if aContent != "base-a\n" {
		t.Fatalf("a.txt after stash group = %q, want base-a", aContent)
	}
	bContent := readFile(t, filepath.Join(root, "b.txt"))
	if bContent != "changed-b\n" {
		t.Fatalf("b.txt after stash group = %q, want changed-b", bContent)
	}
}

// TestParseStashIndexEdgeCases verifies parseStashIndex rejects malformed refs.
func TestParseStashIndexEdgeCases(t *testing.T) {
	cases := []struct {
		ref  string
		want int
	}{
		{"stash@{0}", 0},
		{"stash@{42}", 42},
		{"stash@{}", -1},
		{"stash@{-1}", -1},
		{"stash@{abc}", -1},
		{"", -1},
		{"HEAD", -1},
	}
	for _, c := range cases {
		got := parseStashIndex(c.ref)
		if got != c.want {
			t.Errorf("parseStashIndex(%q) = %d, want %d", c.ref, got, c.want)
		}
	}
}

// TestParseStashSubjectEdgeCases verifies parseStashSubject handles the two patterns.
func TestParseStashSubjectEdgeCases(t *testing.T) {
	cases := []struct {
		raw     string
		branch  string
		message string
	}{
		{"On main: save work", "main", "save work"},
		{"WIP on feature/x: 1234abc base msg", "feature/x", "1234abc base msg"},
		{"custom message", "", "custom message"},
		{"On feat/my-branch: ", "feat/my-branch", "On feat/my-branch: "},
	}
	for _, c := range cases {
		branch, message := parseStashSubject(c.raw)
		if branch != c.branch || message != c.message {
			t.Errorf("parseStashSubject(%q) = (%q, %q), want (%q, %q)",
				c.raw, branch, message, c.branch, c.message)
		}
	}
}

// TestStashApplyNegativeIndexReturnsError verifies negative index is rejected.
func TestStashApplyNegativeIndexReturnsError(t *testing.T) {
	service := New(t.TempDir())
	_, err := service.StashApply(context.Background(), json.RawMessage(`{"index":-1}`))
	if err == nil {
		t.Fatal("StashApply with negative index should return error")
	}
}

// TestStashGroupEmptyPathsReturnsError verifies empty path list is rejected.
func TestStashGroupEmptyPathsReturnsError(t *testing.T) {
	service := New(t.TempDir())
	_, err := service.StashGroup(context.Background(), json.RawMessage(`{"paths":[]}`))
	if err == nil {
		t.Fatal("StashGroup with empty paths should return error")
	}
}

func assertStashListEqual(t *testing.T, name string, got []StashEntry, want []StashEntry) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	gotJSON := canonicalJSON(t, got)
	wantJSON := canonicalJSON(t, want)
	if gotJSON != wantJSON {
		t.Fatalf("%s:\ngot  %s\nwant %s", name, gotJSON, wantJSON)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: struct got %#v want %#v", name, got, want)
	}
}
