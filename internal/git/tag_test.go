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

// tagListExpected mirrors the fixture expected.json for git.tag.list.
type tagListExpected struct {
	Method string `json:"method"`
	Case   string `json:"case"`
	Result []Tag  `json:"result"`
}

// TestTagListFixtures verifies every tag list fixture against parseTagList.
func TestTagListFixtures(t *testing.T) {
	fixtureRoot := tagFixtureRoot(t)
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read tag fixtures: %v", err)
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
		var expected tagListExpected
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		got := parseTagList(string(stdout))
		assertTagListEqual(t, name, got, expected.Result)
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no tag list fixtures loaded")
	}
	t.Logf("loaded %d tag list fixtures", loaded)
}

// TestTagListServiceTempRepo verifies TagList against a real git repository.
func TestTagListServiceTempRepo(t *testing.T) {
	root := t.TempDir()
	tagGitCmd(t, root, "init", "-b", "main")
	tagGitCmd(t, root, "config", "user.email", "nexus@example.test")
	tagGitCmd(t, root, "config", "user.name", "Nexus Test")
	tagWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	tagGitCmd(t, root, "add", "f.txt")
	tagGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)

	// Empty tag list.
	res, err := service.TagList(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("TagList on empty repo returned error: %v", err)
	}
	tags := res.([]Tag)
	if len(tags) != 0 {
		t.Fatalf("TagList expected 0 tags, got %d", len(tags))
	}

	// Create a lightweight tag.
	_, err = service.TagCreate(context.Background(), json.RawMessage(`{"name":"v1.0"}`))
	if err != nil {
		t.Fatalf("TagCreate lightweight returned error: %v", err)
	}

	// Create an annotated tag.
	_, err = service.TagCreate(context.Background(), json.RawMessage(`{"name":"v2.0","message":"release two"}`))
	if err != nil {
		t.Fatalf("TagCreate annotated returned error: %v", err)
	}

	res, err = service.TagList(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("TagList after creates returned error: %v", err)
	}
	tags = res.([]Tag)
	if len(tags) != 2 {
		t.Fatalf("TagList expected 2 tags, got %d", len(tags))
	}

	var light, annotated *Tag
	for i := range tags {
		if tags[i].Name == "v1.0" {
			light = &tags[i]
		}
		if tags[i].Name == "v2.0" {
			annotated = &tags[i]
		}
	}
	if light == nil {
		t.Fatal("lightweight tag v1.0 not found")
	}
	if light.Type != "lightweight" {
		t.Errorf("v1.0 type = %q, want lightweight", light.Type)
	}
	if light.Message != nil {
		t.Errorf("v1.0 message = %v, want nil", light.Message)
	}
	if annotated == nil {
		t.Fatal("annotated tag v2.0 not found")
	}
	if annotated.Type != "annotated" {
		t.Errorf("v2.0 type = %q, want annotated", annotated.Type)
	}
	if annotated.Message == nil || *annotated.Message != "release two" {
		t.Errorf("v2.0 message = %v, want \"release two\"", annotated.Message)
	}
	if annotated.TaggerDate == nil || *annotated.TaggerDate <= 0 {
		t.Errorf("v2.0 taggerDate = %v, want positive epoch ms", annotated.TaggerDate)
	}
}

// TestTagCreateRefNotFound verifies bad ref surfaces as ref-not-found.
func TestTagCreateRefNotFound(t *testing.T) {
	root := t.TempDir()
	tagGitCmd(t, root, "init", "-b", "main")
	tagGitCmd(t, root, "config", "user.email", "nexus@example.test")
	tagGitCmd(t, root, "config", "user.name", "Nexus Test")
	tagWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	tagGitCmd(t, root, "add", "f.txt")
	tagGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)
	_, err := service.TagCreate(context.Background(), json.RawMessage(`{"name":"v1.0","ref":"definitely-missing"}`))
	if err == nil {
		t.Fatal("TagCreate with bad ref should return error")
	}
	if !strings.Contains(err.Error(), "ref-not-found") {
		t.Errorf("TagCreate bad ref error = %q, want ref-not-found", err.Error())
	}
}

// TestTagDeleteServiceTempRepo verifies TagDelete removes a local tag.
func TestTagDeleteServiceTempRepo(t *testing.T) {
	root := t.TempDir()
	tagGitCmd(t, root, "init", "-b", "main")
	tagGitCmd(t, root, "config", "user.email", "nexus@example.test")
	tagGitCmd(t, root, "config", "user.name", "Nexus Test")
	tagWriteFile(t, filepath.Join(root, "f.txt"), "base\n")
	tagGitCmd(t, root, "add", "f.txt")
	tagGitCmd(t, root, "commit", "-m", "initial")

	service := New(root)

	_, err := service.TagCreate(context.Background(), json.RawMessage(`{"name":"v1.0"}`))
	if err != nil {
		t.Fatalf("TagCreate returned error: %v", err)
	}
	_, err = service.TagDelete(context.Background(), json.RawMessage(`{"name":"v1.0"}`))
	if err != nil {
		t.Fatalf("TagDelete returned error: %v", err)
	}

	// Confirm tag is gone.
	res, err := service.TagList(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("TagList after delete returned error: %v", err)
	}
	if len(res.([]Tag)) != 0 {
		t.Fatalf("expected 0 tags after delete, got %d", len(res.([]Tag)))
	}
}

// TestTagNameInvalidRejected verifies invalid tag names are rejected before git.
func TestTagNameInvalidRejected(t *testing.T) {
	service := New(t.TempDir())
	cases := []string{"", "-bad"}
	for _, name := range cases {
		raw, _ := json.Marshal(map[string]string{"name": name})
		_, err := service.TagCreate(context.Background(), raw)
		if err == nil {
			t.Errorf("TagCreate(%q) should reject invalid name", name)
		}
	}
}

// TestTagRegisteredWithDispatcher verifies all tag methods are dispatched.
func TestTagRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	tagGitCmd(t, root, "init", "-b", "main")
	tagGitCmd(t, root, "config", "user.email", "nexus@example.test")
	tagGitCmd(t, root, "config", "user.name", "Nexus Test")
	tagWriteFile(t, filepath.Join(root, "f.txt"), "hello\n")
	tagGitCmd(t, root, "add", "f.txt")
	tagGitCmd(t, root, "commit", "-m", "initial")

	d := dispatch.New()
	Register(d, New(root))

	// git.tag.list on a clean repo returns an empty slice, not an error.
	res := d.Dispatch(context.Background(), proto.Request{
		ID:     "1",
		Method: "git.tag.list",
		Params: json.RawMessage(`{}`),
	})
	if res.Error != nil {
		t.Fatalf("git.tag.list dispatch returned error: %#v", res.Error)
	}
}

// TestParseTagListEmpty verifies parseTagList on empty output.
func TestParseTagListEmpty(t *testing.T) {
	got := parseTagList("")
	if len(got) != 0 {
		t.Fatalf("parseTagList(\"\") = %d tags, want 0", len(got))
	}
}

// TestParseRemoteTagList verifies parseRemoteTagList parses standard ls-remote output.
func TestParseRemoteTagList(t *testing.T) {
	stdout := "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v2.0.0\n"
	got := parseRemoteTagList(stdout, "origin")
	if len(got) != 2 {
		t.Fatalf("parseRemoteTagList got %d tags, want 2", len(got))
	}
	if got[0].Name != "v1.0.0" || got[0].SHA != "abc123" || got[0].Remote != "origin" || got[0].Scope != "remote" {
		t.Errorf("got[0] = %+v", got[0])
	}
}

// TestParseRemoteTagListDereferenced verifies ^{} refs are excluded.
func TestParseRemoteTagListDereferenced(t *testing.T) {
	stdout := "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v1.0.0^{}\n"
	got := parseRemoteTagList(stdout, "origin")
	if len(got) != 1 {
		t.Fatalf("parseRemoteTagList got %d tags, want 1 (^{} should be excluded)", len(got))
	}
}

func tagFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "tag"))
}

func assertTagListEqual(t *testing.T, name string, got []Tag, want []Tag) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	gotJSON := tagCanonicalJSON(t, got)
	wantJSON := tagCanonicalJSON(t, want)
	if gotJSON != wantJSON {
		t.Fatalf("%s:\ngot  %s\nwant %s", name, gotJSON, wantJSON)
	}
}

func tagCanonicalJSON(t *testing.T, value any) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func tagGitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func tagWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
