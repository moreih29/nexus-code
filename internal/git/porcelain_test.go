package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// TestParsePorcelainV2StatusFixtures verifies every manually authored status
// fixture against the pure parser. Service-owned fields are normalized because
// they come from separate host-local subcalls, not porcelain stdout.
func TestParsePorcelainV2StatusFixtures(t *testing.T) {
	fixtureRoot := fixtureDir("status")
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

// A repo-local core.fsmonitor is a command git runs on every status. The
// agent runs status as soon as a folder opens, so a .git/config that came
// with the folder must not be able to run code through it.
func TestStatusIgnoresRepoConfiguredFsmonitorCommand(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	marker := filepath.Join(t.TempDir(), "fsmonitor-ran")
	runGit(t, root, "init", "-b", "main")
	runGit(t, root, "config", "core.fsmonitor", "touch "+marker+"; false")
	writeFile(t, filepath.Join(root, "a.txt"), "x\n")

	if _, err := New(root).Status(context.Background(), json.RawMessage(`{}`)); err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("repo-configured fsmonitor command ran during status")
	}
}
