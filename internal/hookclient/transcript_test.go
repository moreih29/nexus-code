package hookclient

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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

func TestExtractLastAssistantText_EmptyPath(t *testing.T) {
	if got := extractLastAssistantText(""); got != "" {
		t.Errorf("empty path: want empty string, got %q", got)
	}
}

func TestExtractLastAssistantText_NonexistentFile(t *testing.T) {
	if got := extractLastAssistantText("/nonexistent/transcript.jsonl"); got != "" {
		t.Errorf("nonexistent: want empty string, got %q", got)
	}
}

func TestExtractLastAssistantText_EmptyFile(t *testing.T) {
	path := writeTempTranscript(t, "")
	if got := extractLastAssistantText(path); got != "" {
		t.Errorf("empty file: want empty string, got %q", got)
	}
}

func TestExtractLastAssistantText_StringContent(t *testing.T) {
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

func TestTranscriptPathFromPayload_Missing(t *testing.T) {
	payload := []byte(`{"session_id":"x"}`)
	got := transcriptPathFromPayload(payload)
	if got != "" {
		t.Errorf("missing: want empty, got %q", got)
	}
}

func TestTranscriptPathFromPayload_EmptyPayload(t *testing.T) {
	got := transcriptPathFromPayload(nil)
	if got != "" {
		t.Errorf("nil payload: want empty, got %q", got)
	}
}

func TestTranscriptPathFromPayload_Malformed(t *testing.T) {
	payload := []byte(`not json at all`)
	got := transcriptPathFromPayload(payload)
	if got != "" {
		t.Errorf("malformed: want empty, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// waitForTranscriptStable — mtime stability polling
// ---------------------------------------------------------------------------

// 이미 안정된(=mtime이 변하지 않는) 파일이면 첫 polling 주기 후 빠르게 반환.
// 최대 시간보다 한참 안에 끝나야 한다.
func TestWaitForTranscriptStable_AlreadyStable(t *testing.T) {
	path := writeTempTranscript(t, `{"message":{"role":"assistant","content":"done"}}`+"\n")
	// 호출 시점에 파일은 이미 변동 없는 상태. 짧은 interval로 호출.
	start := time.Now()
	waitForTranscriptStable(path, 500*time.Millisecond, 20*time.Millisecond)
	elapsed := time.Since(start)
	// 첫 sleep(20ms) + stat 정도면 끝나야 한다. 여유로 100ms 안.
	if elapsed > 100*time.Millisecond {
		t.Errorf("stable file: should return quickly, took %v", elapsed)
	}
}

// 파일이 계속 자라고 있으면 maxWait까지 polling을 계속하고 결국 반환한다.
func TestWaitForTranscriptStable_ChangingFileTimesOut(t *testing.T) {
	path := writeTempTranscript(t, "{}\n")
	stop := make(chan struct{})
	defer close(stop)

	// 다른 goroutine에서 30ms마다 append해 mtime을 계속 갱신.
	go func() {
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
				if err != nil {
					return
				}
				_, _ = f.WriteString("{}\n")
				_ = f.Close()
			}
		}
	}()

	start := time.Now()
	waitForTranscriptStable(path, 200*time.Millisecond, 50*time.Millisecond)
	elapsed := time.Since(start)
	// maxWait 근처에서 반환해야 한다. 너무 짧으면 안 됨.
	if elapsed < 150*time.Millisecond {
		t.Errorf("changing file: should wait near maxWait, took %v", elapsed)
	}
	// maxWait를 한 interval 이상 크게 넘기면 안 된다.
	if elapsed > 400*time.Millisecond {
		t.Errorf("changing file: should not greatly exceed maxWait, took %v", elapsed)
	}
}

// 존재하지 않는 파일이면 즉시 반환.
func TestWaitForTranscriptStable_NonexistentFile(t *testing.T) {
	start := time.Now()
	waitForTranscriptStable("/nonexistent/transcript.jsonl", 500*time.Millisecond, 50*time.Millisecond)
	elapsed := time.Since(start)
	if elapsed > 50*time.Millisecond {
		t.Errorf("nonexistent: should return immediately, took %v", elapsed)
	}
}

// max — Go 1.21+ built-in이 있지만 명시적 helper로 안정성 확보.
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
