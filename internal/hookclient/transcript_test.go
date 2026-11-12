package hookclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// jsonString quotes s as a JSON string, as a Windows path needs its
// backslashes escaped.
func jsonString(s string) string {
	quoted, _ := json.Marshal(s)
	return string(quoted)
}

// helper: tmp jsonl 파일을 만들어 path를 반환한다.
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
	// content가 string 형태 — 가장 단순한 케이스
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
	// content가 [{type, text}] blocks 형태
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
	// 여러 user/assistant 라인이 있으면, 마지막 user 이후의 assistant만 누적된다.
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
	// user 라인만 있으면 빈 문자열.
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
	// 줄바꿈·연속 공백이 들어간 응답은 single-line으로 정규화된다.
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
	// 500자를 초과하면 잘리고 끝에 ellipsis가 붙는다.
	long := strings.Repeat("a", 600)
	content := `{"message":{"role":"assistant","content":"` + long + `"}}` + "\n"
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncate: want ellipsis suffix, got %q", got[max(0, len(got)-20):])
	}
	// rune count로 검증 (… 포함 501)
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
	// 깨진 JSON 라인은 건너뛰고 다른 라인을 처리한다.
	content := `this is not json
{"message":{"role":"assistant","content":"recovered"}}
`
	path := writeTempTranscript(t, content)
	got := extractLastAssistantText(path)
	if got != "recovered" {
		t.Errorf("malformed: want %q, got %q", "recovered", got)
	}
}

// "마지막 user 이후 누적" 정공법 핵심 — tool_use 직전 짧은 멘트만 마지막
// assistant 라인에 있어도, 그 전 같은 응답 안의 본문 text 블록까지 같이
// 누적되어야 한다. 실제로 본 "1 chars / 18 chars" 결과의 정체일 가능성이
// 높은 케이스.
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

// 마지막 user 이후 첫 assistant가 짧은 멘트만 있고 그 뒤에 본문이 와도
// 둘 다 누적된다. 위 케이스와 같은 의도지만 한 turn 안에서 응답이 split된 경우.
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

// blocks에 text와 tool_use가 섞여 있으면 text만 join — tool_use 등은 무시.
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

// ---------------------------------------------------------------------------
// transcriptPathFromPayload
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// stopAssistantText
// ---------------------------------------------------------------------------

// The payload's answer is taken as is, without the transcript read, whose
// stability check alone sleeps transcriptStableInterval.
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

// An empty answer is the turn's answer too (it ended without text); the
// transcript's older text must not stand in for it.
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

// Versions without last_assistant_message still get the transcript's answer.
func TestStopAssistantText_FallsBackToTranscript(t *testing.T) {
	path := writeTempTranscript(t, `{"message":{"role":"assistant","content":"from transcript"}}`+"\n")
	got := stopAssistantText([]byte(`{"transcript_path":` + jsonString(path) + `}`))
	if got != "from transcript" {
		t.Errorf("fallback: want %q, got %q", "from transcript", got)
	}
}

// ---------------------------------------------------------------------------
// waitForTranscriptStable — mtime stability polling
// ---------------------------------------------------------------------------

// fakeClock 은 sleep할 때만 흐르는 시계. waitUntilSteady를 실제 시간 없이
// 돌려서, CI 머신의 타이머 해상도나 스케줄링과 상관없이 결과가 같다.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time                   { return c.t }
func (c *fakeClock) sleep(d time.Duration)            { c.t = c.t.Add(d) }
func (c *fakeClock) since(t0 time.Time) time.Duration { return c.t.Sub(t0) }

// 파일이 계속 자라고 있으면 maxWait까지 polling을 계속하고, 넘기지 않고 반환한다.
func TestWaitUntilSteady_ChangingFileWaitsUntilMaxWait(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	start := clock.now()
	size := int64(0)
	polls := 0
	waitUntilSteady(func() (fileMark, bool) {
		polls++
		size++ // 매번 자란다
		return fileMark{mtime: clock.now(), size: size}, true
	}, 200*time.Millisecond, 50*time.Millisecond, clock.now, clock.sleep)
	if waited := clock.since(start); waited != 200*time.Millisecond {
		t.Errorf("changing file: want to wait exactly maxWait (200ms), waited %v", waited)
	}
	// 처음 한 번 + 50ms마다 4번.
	if polls != 5 {
		t.Errorf("changing file: want 5 looks, got %d", polls)
	}
}

// 한 interval 동안 변하지 않으면 그 자리에서 반환한다.
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

// mtime이 같아도 size가 자라면 아직 쓰이는 중이다 (mtime 해상도가 거친 fs).
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

// 파일이 없으면 기다리지 않는다.
func TestWaitForTranscriptStable_MissingFileReturnsAtOnce(t *testing.T) {
	start := time.Now()
	waitForTranscriptStable(filepath.Join(t.TempDir(), "missing.jsonl"), time.Second, 100*time.Millisecond)
	if elapsed := time.Since(start); elapsed >= time.Second {
		t.Errorf("missing file: should return at once, took %v", elapsed)
	}
}

// max — Go 1.21+ built-in이 있지만 명시적 helper로 안정성 확보.
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
