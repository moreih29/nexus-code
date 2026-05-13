package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type commitDetailExpected struct {
	Method string             `json:"method"`
	Case   string             `json:"case"`
	Params CommitDetailParams `json:"params"`
	Result CommitDetail       `json:"result"`
}

// TestParseCommitDetailFixtures verifies every commit-detail parser fixture.
func TestParseCommitDetailFixtures(t *testing.T) {
	fixtureRoot := commitDetailFixtureRoot(t)
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
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "old.txt"), "base\n")
	runGitCommand(t, root, "add", "old.txt")
	runGitCommand(t, root, "commit", "-m", "initial")
	runGitCommand(t, root, "mv", "old.txt", "new.txt")
	runGitCommand(t, root, "commit", "-m", "Rename file", "-m", "Body line")
	sha := strings.TrimSpace(runGitOutput(t, root, "rev-parse", "HEAD"))

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
	if len(detail.Files) != 1 || detail.Files[0].Status[0] != 'R' || detail.Files[0].OldPath != "old.txt" || detail.Files[0].Path != "new.txt" {
		t.Fatalf("files got %#v want rename old.txt -> new.txt", detail.Files)
	}
}

func TestCommitDetailRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "hello\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")
	sha := strings.TrimSpace(runGitOutput(t, root, "rev-parse", "HEAD"))

	d := dispatch.New()
	Register(d, New(root))
	res := d.Dispatch(context.Background(), proto.Request{ID: "git.commitDetail", Method: "git.commitDetail", Params: json.RawMessage(`{"sha":"` + sha + `"}`)})
	if res.Error != nil {
		t.Fatalf("git.commitDetail dispatch returned error: %#v", res.Error)
	}
	if _, ok := res.Result.(CommitDetail); !ok {
		t.Fatalf("git.commitDetail result type = %T", res.Result)
	}
}

func commitDetailFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "commit-detail"))
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

func runGitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}
