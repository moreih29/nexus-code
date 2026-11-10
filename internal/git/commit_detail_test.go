package git

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type commitDetailExpected struct {
	Method string             `json:"method"`
	Case   string             `json:"case"`
	Params CommitDetailParams `json:"params"`
	Result CommitDetail       `json:"result"`
}

// TestParseCommitDetailFixtures verifies every commit-detail parser fixture.
func TestParseCommitDetailFixtures(t *testing.T) {
	fixtureRoot := fixtureDir("commit-detail")
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read commit-detail fixtures: %v", err)
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
		var expected commitDetailExpected
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		got, err := ParseCommitDetail(stdout)
		if err != nil {
			t.Fatalf("%s: ParseCommitDetail: %v", name, err)
		}
		assertCommitDetailEqual(t, name, got, expected.Result)
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no commit-detail fixtures loaded")
	}
	t.Logf("loaded %d commit-detail fixtures", loaded)
}

func assertCommitDetailEqual(t *testing.T, name string, got CommitDetail, expected CommitDetail) {
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
