package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"
)

type expectedClassifiedError struct {
	Kind    Kind                   `json:"kind"`
	Message string                 `json:"message"`
	Hint    map[string]interface{} `json:"hint"`
}

// TestClassifyStderrFixtures verifies every manually authored stderr fixture.
func TestClassifyStderrFixtures(t *testing.T) {
	fixtureRoot := stderrFixtureRoot(t)
	cases, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read stderr fixtures: %v", err)
	}

	loaded := 0
	for _, entry := range cases {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(fixtureRoot, name)
		stderrBytes, err := os.ReadFile(filepath.Join(dir, "stderr.bin"))
		if err != nil {
			t.Fatalf("%s: read stderr.bin: %v", name, err)
		}
		expectedBytes, err := os.ReadFile(filepath.Join(dir, "expected.json"))
		if err != nil {
			t.Fatalf("%s: read expected.json: %v", name, err)
		}
		var expected expectedClassifiedError
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		stderr := string(stderrBytes)
		if got := Classify(stderr); got != expected.Kind {
			t.Errorf("%s: kind got %q want %q", name, got, expected.Kind)
		}
		if got := MessageForKind(expected.Kind, MessageContext{Stderr: stderr}); got != expected.Message {
			t.Errorf("%s: message got %q want %q", name, got, expected.Message)
		}
		if got := hintMap(t, HintForKind(expected.Kind)); !reflect.DeepEqual(got, expected.Hint) {
			t.Errorf("%s: hint got %#v want %#v", name, got, expected.Hint)
		}
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no stderr fixtures loaded")
	}
	t.Logf("loaded %d stderr fixtures", loaded)
}

// TestRunStdoutOverflowIsClassifiedData guards the run.go transport envelope.
func TestRunStdoutOverflowIsClassifiedData(t *testing.T) {
	service := New(t.TempDir())
	raw := json.RawMessage(`{"args":["--no-pager","help","-a"],"stdoutCapBytes":1024}`)
	result, err := service.Run(context.Background(), raw)
	if err != nil {
		t.Fatalf("Run returned transport error: %v", err)
	}
	runResult, ok := result.(RunResult)
	if !ok {
		t.Fatalf("Run result type = %T", result)
	}
	if runResult.Code != 0 {
		t.Fatalf("Code got %d want 0", runResult.Code)
	}
	if runResult.ErrorKind != KindOutputTooLarge {
		t.Fatalf("ErrorKind got %q want %q", runResult.ErrorKind, KindOutputTooLarge)
	}
	if runResult.ErrorMessage == "" {
		t.Fatal("ErrorMessage is empty")
	}
}

// stderrFixtureRoot returns the repo-relative stderr fixture directory.
func stderrFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "stderr"))
}

// hintMap marshals a Go hint through JSON so its shape matches fixture JSON.
func hintMap(t *testing.T, hint *ActionHint) map[string]interface{} {
	t.Helper()
	if hint == nil {
		return nil
	}
	bytes, err := json.Marshal(hint)
	if err != nil {
		t.Fatalf("marshal hint: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("unmarshal hint: %v", err)
	}
	normalizeMap(decoded)
	return decoded
}

// normalizeMap gives stable empty-object equality for JSON-derived maps.
func normalizeMap(value map[string]interface{}) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value[key] == nil {
			delete(value, key)
		}
	}
}
