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

func TestCommitDetailServiceTempRepoShape(t *testing.T) {
	t.Parallel()
	root := newRepo(t)
	runGit(t, root, "mv", "README.md", "new.txt")
	runGit(t, root, "commit", "-m", "Rename file", "-m", "Body line")
	sha := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	service := New(root)
	res, err := service.CommitDetail(context.Background(), json.RawMessage(`{"sha":"`+sha+`"}`))
	if err != nil {
		t.Fatalf("CommitDetail returned error: %v", err)
	}
	detail, ok := res.(CommitDetail)
	if !ok {
		t.Fatalf("CommitDetail result type = %T", res)
	}
	if detail.SHA != sha || detail.Subject != "Rename file" || detail.Body != "Body line" {
		t.Fatalf("unexpected detail metadata: %#v", detail)
	}
	if len(detail.Parents) != 1 {
		t.Fatalf("parents got %#v want one parent", detail.Parents)
	}
	if len(detail.Files) != 1 || detail.Files[0].Status[0] != 'R' || detail.Files[0].OldPath != "README.md" || detail.Files[0].Path != "new.txt" {
		t.Fatalf("files got %#v want rename README.md -> new.txt", detail.Files)
	}
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
