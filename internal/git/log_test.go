package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type logExpected struct {
	Method string             `json:"method"`
	Case   string             `json:"case"`
	Params LogParams          `json:"params"`
	Events []logExpectedEvent `json:"events"`
	Result LogResult          `json:"result"`
}

type logExpectedEvent struct {
	Name    string          `json:"name"`
	Payload LogBatchPayload `json:"payload"`
}

// TestLogFixtures verifies every manually authored log fixture against the Go
// record parser, cursor/limit logic, and git.log.batch payload shape.
func TestLogFixtures(t *testing.T) {
	fixtureRoot := logFixtureRoot(t)
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read log fixtures: %v", err)
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
		var expected logExpected
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		service := New(t.TempDir())
		var gotEvents []logExpectedEvent
		service.SetEventSink(func(event string, payload any) error {
			batch, ok := payload.(LogBatchPayload)
			if !ok {
				t.Fatalf("%s: payload type = %T", name, payload)
			}
			gotEvents = append(gotEvents, logExpectedEvent{Name: event, Payload: batch})
			return nil
		})

		gotResult, err := service.consumeLogOutput(context.Background(), bytes.NewReader(stdout), expected.Params, nil)
		if err != nil {
			t.Fatalf("%s: consumeLogOutput: %v", name, err)
		}
		assertLogResultEqual(t, name, gotResult, expected.Result)
		assertLogEventsEqual(t, name, gotEvents, expected.Events)
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no log fixtures loaded")
	}
	t.Logf("loaded %d log fixtures", loaded)
}

func TestLogBatchesAtLogBatchSizeAndCarriesStreamID(t *testing.T) {
	stdout := syntheticLogStdout(LogBatchSize + 1)
	params := LogParams{Scope: "ref", StreamID: "stream-log-1"}
	service := New(t.TempDir())
	var batches []LogBatchPayload
	service.SetEventSink(func(event string, payload any) error {
		if event != "git.log.batch" {
			t.Fatalf("event = %s, want git.log.batch", event)
		}
		batches = append(batches, payload.(LogBatchPayload))
		return nil
	})

	result, err := service.consumeLogOutput(context.Background(), bytes.NewReader(stdout), params, nil)
	if err != nil {
		t.Fatalf("consumeLogOutput: %v", err)
	}
	if result.Count != LogBatchSize+1 || result.HasMore {
		t.Fatalf("result = %#v", result)
	}
	if len(batches) != 2 || len(batches[0].Entries) != LogBatchSize || len(batches[1].Entries) != 1 {
		t.Fatalf("batch sizes = %#v", batchSizes(batches))
	}
	for _, batch := range batches {
		if batch.StreamID != params.StreamID {
			t.Fatalf("batch streamId = %q, want %q", batch.StreamID, params.StreamID)
		}
	}
}

func TestBuildLogArgsCoversScopeSourceCursorAndPaths(t *testing.T) {
	sourceOff := false
	skip := 3
	args := buildLogArgs(LogParams{Scope: "ref", Ref: "main", Skip: &skip, Limit: 5})
	want := []string{
		"log",
		"--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D%x1e",
		"--date=iso-strict",
		"--skip=3",
		"--max-count=6",
		"main",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("ref skip args = %#v\nwant %#v", args, want)
	}

	args = buildLogArgs(LogParams{
		Scope:    "all",
		Source:   &sourceOff,
		AfterSHA: "abc123",
		Grep:     "UI-42",
		Limit:    10,
		Paths:    []string{"src/a.ts", "README.md"},
	})
	want = []string{
		"log",
		"--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D%x1e",
		"--date=iso-strict",
		"--grep=UI-42",
		"--all",
		"--",
		"src/a.ts",
		"README.md",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v\nwant %#v", args, want)
	}

	sourceOn := true
	args = buildLogArgs(LogParams{Scope: "branches", Source: &sourceOn, Limit: 1})
	want = []string{
		"log",
		"--pretty=format:%S%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D%x1e",
		"--date=iso-strict",
		"--max-count=2",
		"--source",
		"--branches",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("branches args = %#v\nwant %#v", args, want)
	}
}

func TestParseLogParamsRejectsSkipOutsideRefScope(t *testing.T) {
	_, err := parseLogParams(json.RawMessage(`{"scope":"all","skip":0}`))
	if err == nil || !strings.Contains(err.Error(), "skip is only supported for ref scope") {
		t.Fatalf("err = %v, want ref-scope skip validation", err)
	}
}

func TestLogLimitLookaheadInvokesKillCallback(t *testing.T) {
	stdout := syntheticLogStdout(3)
	params := LogParams{Scope: "ref", Limit: 2}
	service := New(t.TempDir())
	killed := false
	result, err := service.consumeLogOutput(context.Background(), bytes.NewReader(stdout), params, func() error {
		killed = true
		return nil
	})
	if err != nil {
		t.Fatalf("consumeLogOutput: %v", err)
	}
	if !killed {
		t.Fatal("limit lookahead did not invoke kill callback")
	}
	if result.Count != 2 || !result.HasMore || result.TotalScanned == nil || *result.TotalScanned != 3 {
		t.Fatalf("result = %#v", result)
	}
}

func TestLogLimitCursorKillsPromptly(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	tree := strings.TrimSpace(runGitOutput(t, root, "mktree"))
	parent := ""
	for i := 0; i < 1000; i++ {
		args := []string{"commit-tree", tree, "-m", fmt.Sprintf("commit %04d", i)}
		if parent != "" {
			args = append(args, "-p", parent)
		}
		parent = strings.TrimSpace(runGitOutput(t, root, args...))
	}
	runGitCommand(t, root, "update-ref", "refs/heads/main", parent)
	head := strings.TrimSpace(runGitOutput(t, root, "rev-parse", "HEAD"))

	service := New(root)
	batchCount := 0
	service.SetEventSink(func(event string, payload any) error {
		if event != "git.log.batch" {
			t.Fatalf("event = %s", event)
		}
		batchCount++
		return nil
	})

	start := time.Now()
	res, err := service.Log(context.Background(), json.RawMessage(`{"scope":"all","afterSha":"`+head+`","limit":1,"source":true,"streamId":"limit-kill"}`))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Log returned error: %v", err)
	}
	result, ok := res.(LogResult)
	if !ok {
		t.Fatalf("Log result type = %T", res)
	}
	if result.Count != 1 || !result.HasMore || result.TotalScanned == nil || *result.TotalScanned != 3 {
		t.Fatalf("result = %#v, want count=1 hasMore=true totalScanned=3", result)
	}
	if batchCount != 1 {
		t.Fatalf("batchCount = %d, want 1", batchCount)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("limit log took %s, want prompt stop under 2s", elapsed)
	}
}

func TestLogRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "hello\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	d := dispatch.New()
	service := New(root)
	batchCount := 0
	service.SetEventSink(func(event string, payload any) error {
		if event == "git.log.batch" {
			batchCount++
		}
		return nil
	})
	Register(d, service)
	res := d.Dispatch(context.Background(), proto.Request{ID: "git.log", Method: "git.log", Params: json.RawMessage(`{"scope":"ref","ref":"HEAD","limit":1}`)})
	if res.Error != nil {
		t.Fatalf("git.log dispatch returned error: %#v", res.Error)
	}
	result, ok := res.Result.(LogResult)
	if !ok {
		t.Fatalf("git.log result type = %T", res.Result)
	}
	if result.Count != 1 || result.HasMore || batchCount != 1 {
		t.Fatalf("result=%#v batchCount=%d", result, batchCount)
	}
}

func logFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "log"))
}

func assertLogResultEqual(t *testing.T, name string, got LogResult, expected LogResult) {
	t.Helper()
	gotJSON := canonicalJSON(t, got)
	expectedJSON := canonicalJSON(t, expected)
	if gotJSON != expectedJSON {
		t.Fatalf("%s result:\ngot  %s\nwant %s", name, gotJSON, expectedJSON)
	}
}

func assertLogEventsEqual(t *testing.T, name string, got []logExpectedEvent, expected []logExpectedEvent) {
	t.Helper()
	gotJSON := canonicalJSON(t, got)
	expectedJSON := canonicalJSON(t, expected)
	if gotJSON != expectedJSON {
		t.Fatalf("%s events:\ngot  %s\nwant %s", name, gotJSON, expectedJSON)
	}
}

func syntheticLogStdout(count int) []byte {
	var buf bytes.Buffer
	for i := 0; i < count; i++ {
		sha := fmt.Sprintf("%040d", i+1)
		short := sha[:7]
		fields := []string{sha, short, "", "Author", "author@example.test", "2026-05-01T00:00:00+00:00", fmt.Sprintf("Subject %d", i+1), "", ""}
		buf.WriteString(stringsJoin(fields, logFieldSeparator))
		buf.WriteString(logRecordSeparator)
	}
	return buf.Bytes()
}

func stringsJoin(values []string, sep string) string {
	if len(values) == 0 {
		return ""
	}
	out := values[0]
	for _, value := range values[1:] {
		out += sep + value
	}
	return out
}

func batchSizes(batches []LogBatchPayload) []int {
	sizes := make([]int, len(batches))
	for i, batch := range batches {
		sizes[i] = len(batch.Entries)
	}
	return sizes
}
