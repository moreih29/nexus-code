package hookclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func jsonString(s string) string {
	quoted, _ := json.Marshal(s)
	return string(quoted)
}

func writeTempTranscript(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write tmp transcript: %v", err)
	}
	return path
}

func TestExtractLastAssistantText_StringContent(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"user","content":"Hello"}}
{"message":{"role":"assistant","content":"Hi there!"}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "Hi there!" {
		t.Errorf("string content: want %q, got %q", "Hi there!", got)
	}
}

func TestExtractLastAssistantText_BlocksContent(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"user","content":"Hello"}}
{"message":{"role":"assistant","content":[{"type":"text","text":"Sure, here is the answer."}]}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "Sure, here is the answer." {
		t.Errorf("blocks content: want %q, got %q", "Sure, here is the answer.", got)
	}
}

func TestExtractLastAssistantText_LastUserResetsAccumulation(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"assistant","content":"first answer"}}
{"message":{"role":"user","content":"follow up"}}
{"message":{"role":"assistant","content":"second answer"}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "second answer" {
		t.Errorf("user-resets: want %q, got %q", "second answer", got)
	}
}

func TestExtractLastAssistantText_NoAssistant(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"user","content":"only user"}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "" {
		t.Errorf("user-only: want empty, got %q", got)
	}
}

func TestExtractLastAssistantText_MultilineNormalized(t *testing.T) {
	t.Parallel()
	content := "{\"message\":{\"role\":\"assistant\",\"content\":\"line one\\nline two\\n\\n   tabbed\\there\"}}\n"
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	want := "line one line two tabbed here"
	if got != want {
		t.Errorf("normalize: want %q, got %q", want, got)
	}
}

func TestExtractLastAssistantText_LongTruncated(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("a", 600)
	content := `{"message":{"role":"assistant","content":"` + long + `"}}` + "\n"
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncate: want ellipsis suffix, got %q", got[max(0, len(got)-20):])
	}
	runeCount := 0
	for range got {
		runeCount++
	}
	if runeCount != transcriptPreviewMaxChars+1 {
		t.Errorf("truncate length: want %d runes (with ellipsis), got %d", transcriptPreviewMaxChars+1, runeCount)
	}
}

func TestExtractLastAssistantText_MalformedLineSkipped(t *testing.T) {
	t.Parallel()
	content := `this is not json
{"message":{"role":"assistant","content":"recovered"}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "recovered" {
		t.Errorf("malformed: want %q, got %q", "recovered", got)
	}
}

func TestExtractLastAssistantText_AccumulatesMultipleAssistantTurns(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"user","content":"Please analyze the codebase."}}
{"message":{"role":"assistant","content":[{"type":"text","text":"I'll check the file."}]}}
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"message":{"role":"assistant","content":[{"type":"tool_result","content":"file contents"}]}}
{"message":{"role":"assistant","content":[{"type":"text","text":"Here is the answer."}]}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	want := "I'll check the file. Here is the answer."
	if got != want {
		t.Errorf("accumulate: want %q, got %q", want, got)
	}
}

func TestExtractLastAssistantText_TwoTextBlocksInSameTurn(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"user","content":"hi"}}
{"message":{"role":"assistant","content":[{"type":"text","text":"Sure."},{"type":"text","text":"Here's more detail."}]}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	want := "Sure. Here's more detail."
	if got != want {
		t.Errorf("two-blocks-same-turn: want %q, got %q", want, got)
	}
}

func TestExtractLastAssistantText_BlocksWithToolUseSkipped(t *testing.T) {
	t.Parallel()
	content := `{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}},{"type":"text","text":"Running the command."}]}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "Running the command." {
		t.Errorf("text-with-tool_use: want %q, got %q", "Running the command.", got)
	}
}

func TestTranscriptPathFromPayload_SnakeCase(t *testing.T) {
	payload := []byte(`{"transcript_path":"/tmp/t.jsonl","session_id":"x"}`)
	got := transcriptPathFromPayload(payload)
	if got != "/tmp/t.jsonl" {
		t.Errorf("snake_case: want %q, got %q", "/tmp/t.jsonl", got)
	}
}

func TestTranscriptPathFromPayload_CamelCase(t *testing.T) {
	payload := []byte(`{"transcriptPath":"/tmp/u.jsonl"}`)
	got := transcriptPathFromPayload(payload)
	if got != "/tmp/u.jsonl" {
		t.Errorf("camelCase: want %q, got %q", "/tmp/u.jsonl", got)
	}
}

func TestStopAssistantText_PayloadAnswerSkipsTranscript(t *testing.T) {
	path := writeTempTranscript(t, `{"message":{"role":"assistant","content":"from transcript"}}`+"\n")
	payload := []byte(`{"transcript_path":` + jsonString(path) + `,"last_assistant_message":"Done.\n\nAll  tests pass."}`)
	start := time.Now()
	got := stopAssistantText(payload)
	if got != "Done. All tests pass." {
		t.Errorf("payload answer: want %q, got %q", "Done. All tests pass.", got)
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Errorf("payload answer: should not wait for the transcript, took %v", elapsed)
	}
}

func TestStopAssistantText_EmptyPayloadAnswer(t *testing.T) {
	path := writeTempTranscript(t, `{"message":{"role":"assistant","content":"from transcript"}}`+"\n")
	payload := []byte(`{"transcript_path":` + jsonString(path) + `,"last_assistant_message":""}`)
	if got := stopAssistantText(payload); got != "" {
		t.Errorf("empty payload answer: want empty, got %q", got)
	}
}

func TestStopAssistantText_PayloadAnswerTruncated(t *testing.T) {
	long := strings.Repeat("a", transcriptPreviewMaxChars+50)
	got := stopAssistantText([]byte(`{"last_assistant_message":"` + long + `"}`))
	if want := truncateChars(long, transcriptPreviewMaxChars); got != want {
		t.Errorf("long payload answer: want %d chars, got %d", len(want), len(got))
	}
}

func TestStopAssistantText_FallsBackToTranscript(t *testing.T) {
	path := writeTempTranscript(t, `{"message":{"role":"assistant","content":"from transcript"}}`+"\n")
	got := stopAssistantText([]byte(`{"transcript_path":` + jsonString(path) + `}`))
	if got != "from transcript" {
		t.Errorf("fallback: want %q, got %q", "from transcript", got)
	}
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time                   { return c.t }
func (c *fakeClock) sleep(d time.Duration)            { c.t = c.t.Add(d) }
func (c *fakeClock) since(t0 time.Time) time.Duration { return c.t.Sub(t0) }

func TestWaitUntilSteady_ChangingFileWaitsUntilMaxWait(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	start := clock.now()
	size := int64(0)
	polls := 0
	waitUntilSteady(func() (fileMark, bool) {
		polls++
		size++
		return fileMark{mtime: clock.now(), size: size}, true
	}, 200*time.Millisecond, 50*time.Millisecond, clock.now, clock.sleep)
	if waited := clock.since(start); waited != 200*time.Millisecond {
		t.Errorf("changing file: want to wait exactly maxWait (200ms), waited %v", waited)
	}
	if polls != 5 {
		t.Errorf("changing file: want 5 looks, got %d", polls)
	}
}

func TestWaitUntilSteady_SteadyFileReturnsAfterOneInterval(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	start := clock.now()
	mark := fileMark{mtime: time.Unix(100, 0), size: 10}
	waitUntilSteady(func() (fileMark, bool) { return mark, true },
		time.Second, 100*time.Millisecond, clock.now, clock.sleep)
	if waited := clock.since(start); waited != 100*time.Millisecond {
		t.Errorf("steady file: want one interval (100ms), waited %v", waited)
	}
}

func TestWaitUntilSteady_GrowingSizeWithSameMtimeKeepsWaiting(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	start := clock.now()
	sizes := []int64{10, 20, 30, 30}
	i := 0
	waitUntilSteady(func() (fileMark, bool) {
		m := fileMark{mtime: time.Unix(100, 0), size: sizes[i]}
		i++
		return m, true
	}, time.Second, 100*time.Millisecond, clock.now, clock.sleep)
	if waited := clock.since(start); waited != 300*time.Millisecond {
		t.Errorf("growing size: want to stop once it stops growing (300ms), waited %v", waited)
	}
}

func TestWaitForTranscriptStable_MissingFileReturnsAtOnce(t *testing.T) {
	start := time.Now()
	waitForTranscriptStable(filepath.Join(t.TempDir(), "missing.jsonl"), time.Second, 100*time.Millisecond)
	if elapsed := time.Since(start); elapsed >= time.Second {
		t.Errorf("missing file: should return at once, took %v", elapsed)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
