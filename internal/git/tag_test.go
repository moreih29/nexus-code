package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type tagListExpected struct {
	Method string `json:"method"`
	Case   string `json:"case"`
	Result []Tag  `json:"result"`
}

func TestTagListFixtures(t *testing.T) {
	fixtureRoot := fixtureDir("tag")
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

func TestParseRemoteTagListDereferenced(t *testing.T) {
	stdout := "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v1.0.0^{}\n"
	got := parseRemoteTagList(stdout, "origin")
	if len(got) != 1 {
		t.Fatalf("parseRemoteTagList got %d tags, want 1 (^{} should be excluded)", len(got))
	}
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
