// Package hookclient의 transcript 파일에서 마지막 응답 텍스트를 추출하는 helper.
//
// Claude Code의 Stop hook payload는 transcript_path 필드만 제공하며, 응답 본문은
// 별도로 전달되지 않는다. 사이드바 카드에 응답 미리보기를 표시하려면 Stop hook을
// 받은 시점에 hook 실행 호스트의 fs에서 transcript jsonl을 읽어 마지막 응답을
// 추출해야 한다. hookclient는 항상 transcript와 동일 호스트에서 실행되므로
// (로컬 워크스페이스든 SSH 원격이든) main이 호스트별 fs 라우팅을 알 필요 없다.
//
// transcript 포맷은 라인 단위 JSON(jsonl)이며, 각 라인은 다음 형태를 갖는다:
//
//	{
//	  "message": {
//	    "role": "user" | "assistant" | "system",
//	    "content": "텍스트" | [{"type":"text","text":"..."}, {"type":"tool_use",...}, ...]
//	  },
//	  ...
//	}
//
// references/cmux의 readTranscriptSummary 패턴을 따르되 두 가지를 보강한다:
//
//  1. **mtime stability polling**: Stop hook은 Claude Code가 응답 완료를 신호한
//     시점이지만 transcript jsonl로의 flush가 그 직후라 race가 있다. Stop을
//     받자마자 read하면 마지막 항목이 아직 안 들어와 있거나 부분만 들어와 있는
//     경우가 관찰됨. 따라서 mtime이 2회 연속 같아질 때까지(=flush 완료) 짧게
//     polling 후 read한다.
//
//  2. **"마지막 user 이후의 모든 assistant text 누적"**: cmux처럼 "마지막
//     assistant 한 줄"만 보면 thinking/tool_use 직전의 짧은 멘트(예: "I'll check
//     the file...")가 잡혀 의미가 약해진다. 대신 transcript를 순차 읽으며 user
//     라인을 만날 때마다 누적을 리셋하고, 끝나면 마지막 user 이후의 모든
//     assistant text 블록을 공백으로 join해 반환한다.
package hookclient

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

// transcriptMaxBytes 는 안전망. transcript가 비정상적으로 크면 그 위는 무시한다.
// 일반 세션은 수십 KB ~ 수백 KB 수준이라 이 한계에 닿는 일은 거의 없다.
const transcriptMaxBytes int64 = 2 * 1024 * 1024 // 2MB

// transcriptPreviewMaxChars 는 main 으로 송신하기 전 자르는 최대 문자 길이.
// 사이드바 카드는 50자만 표시하지만, 토큰 단위 cut에 대비해 여유 있게 둔다.
// renderer 측에서 한 번 더 폭에 맞춰 자른다.
const transcriptPreviewMaxChars = 500

// transcriptLineMaxBytes 는 단일 라인 크기 상한. jsonl 한 줄에 대용량 첨부
// 등이 박혀 있어도 scanner가 죽지 않도록 buffer를 충분히 크게 둔다.
const transcriptLineMaxBytes = 1 * 1024 * 1024 // 1MB

// transcriptStableMaxWait 는 mtime stability polling의 최대 대기 시간.
// Claude Code의 응답 완료 시점부터 transcript flush 완료까지의 race 윈도우를
// 덮기에 충분한 시간 — 일반 케이스는 100~300ms 안에 끝난다. hook 자체는
// async라 hookclient 프로세스가 이만큼 더 살아도 Claude Code에 영향 없다.
const transcriptStableMaxWait = 1 * time.Second

// transcriptStableInterval 은 mtime polling 주기.
const transcriptStableInterval = 100 * time.Millisecond

// extractLastAssistantText 는 transcript flush 완료(mtime stable)를 짧게 기다린
// 뒤, 마지막 user 메시지 이후의 모든 assistant text 블록을 공백으로 join해
// 단일 줄로 정규화·truncate한 결과를 반환한다.
//
// 어떤 단계에서든 실패하면 빈 문자열을 반환한다 — Stop hook 처리 흐름을 막지
// 않는 silent fallback.
//
// 빈 문자열을 반환하는 경우:
//   - transcriptPath 가 비어있음
//   - 파일 stat / open 실패
//   - 파일 크기 0
//   - 마지막 user 이후 assistant 메시지가 한 건도 없음(tool-only turn 등)
func extractLastAssistantText(transcriptPath string) string {
	if transcriptPath == "" {
		return ""
	}
	waitForTranscriptStable(transcriptPath, transcriptStableMaxWait, transcriptStableInterval)
	return readAssistantTextSinceLastUser(transcriptPath)
}

// waitForTranscriptStable 은 transcriptPath의 mtime이 두 번 연속 동일해질 때까지
// 짧게 polling한다. mtime이 변하지 않으면 Claude Code의 transcript flush가
// 완료됐다고 판단한다. maxWait를 초과하면 best-effort로 즉시 반환한다.
//
// 파일이 없거나 stat 실패는 silent — 호출자가 빈 결과로 자연히 처리.
func waitForTranscriptStable(path string, maxWait, interval time.Duration) {
	deadline := time.Now().Add(maxWait)

	first, err := os.Stat(path)
	if err != nil {
		return
	}
	prevMtime := first.ModTime()
	prevSize := first.Size()

	for time.Now().Before(deadline) {
		time.Sleep(interval)
		info, err := os.Stat(path)
		if err != nil {
			return
		}
		// mtime + size 둘 다 변동 없으면 flush 완료. 둘 다 본다 — 일부 fs에서
		// mtime 해상도가 거칠어 동일 ms 안에 두 write가 일어나면 mtime은 안
		// 변해도 size는 자라기 때문.
		if info.ModTime().Equal(prevMtime) && info.Size() == prevSize {
			return
		}
		prevMtime = info.ModTime()
		prevSize = info.Size()
	}
}

// readAssistantTextSinceLastUser 는 transcript를 순차 읽으며 user 라인을 만날
// 때마다 assistant 누적을 리셋하고, 끝나면 마지막 user 이후의 모든 assistant
// text 블록을 공백으로 join한 결과를 single-line 정규화 + truncate해 반환한다.
//
// "마지막 assistant 한 줄"만 보던 cmux 패턴은 tool_use 직전의 짧은 멘트("I'll
// check the file..." 같은)가 잡히는 약점이 있다. 마지막 user 이후를 모두 누적
// 하면 [text "I'll check"] [tool_use] [tool_result] [text "Here is..."] 같은
// 응답 구조에서도 전체 응답이 잡힌다.
func readAssistantTextSinceLastUser(path string) string {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return ""
	}

	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	// 안전망: 파일이 한계보다 크면 끝쪽 transcriptMaxBytes만 읽는다. 끝쪽이
	// 새 메시지가 있을 곳이라 가장 의미 있는 영역이다. 단 잘린 영역의 첫
	// 라인은 헤더가 손상돼 있을 수 있어 한 줄 건너뛴다.
	var reader io.Reader = f
	if info.Size() > transcriptMaxBytes {
		if _, err := f.Seek(info.Size()-transcriptMaxBytes, io.SeekStart); err != nil {
			return ""
		}
		br := bufio.NewReaderSize(f, 64*1024)
		if _, err := br.ReadString('\n'); err != nil && err != io.EOF {
			return ""
		}
		reader = br
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), transcriptLineMaxBytes)

	// 마지막 user 이후의 assistant text 누적. user 라인 만날 때마다 리셋.
	var accum []string
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		role, text, ok := decodeRoleAndText(line)
		if !ok {
			continue
		}
		switch role {
		case "user":
			// 마지막 user 이후만 누적하기 위해 매번 리셋.
			accum = accum[:0]
		case "assistant":
			if text != "" {
				accum = append(accum, text)
			}
		}
	}

	if len(accum) == 0 {
		return ""
	}
	joined := strings.Join(accum, " ")
	return truncateChars(normalizeSingleLine(joined), transcriptPreviewMaxChars)
}

// transcriptLine 은 transcript jsonl의 한 라인을 디코드할 때 사용하는 부분 스키마.
// 다른 필드는 무시한다.
type transcriptLine struct {
	Message *transcriptMessage `json:"message"`
}

type transcriptMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// transcriptContentBlock 은 content 배열의 한 블록(content array form)이다.
// Claude Code의 transcript는 `content`가 string인 경우와 [{type, text, ...}]
// 배열인 경우 둘 다 있다.
type transcriptContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// decodeRoleAndText 는 transcript jsonl 한 줄을 디코드해 (role, text, ok)를
// 반환한다. message가 없거나 디코드 실패 시 ok=false.
//
// role이 "assistant"가 아니어도 (예: "user", "system") role 정보 자체는
// 반환한다 — 호출자가 user 라인을 보고 누적을 리셋해야 하기 때문.
func decodeRoleAndText(line []byte) (role, text string, ok bool) {
	var parsed transcriptLine
	if err := json.Unmarshal(line, &parsed); err != nil {
		return "", "", false
	}
	if parsed.Message == nil {
		return "", "", false
	}
	role = parsed.Message.Role
	if role != "assistant" {
		// user/system 등은 role만 보면 충분 — 누적 리셋 판단용.
		return role, "", true
	}
	t, _ := decodeContentText(parsed.Message.Content)
	return role, t, true
}

// decodeContentText 는 message.content 의 두 형태(string / blocks 배열)을 모두
// 처리해 텍스트만 추출한다. blocks 배열에서는 type=="text"인 블록의 text만
// 모은다 (tool_use, tool_result 등은 무시).
func decodeContentText(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}

	// string 형태 시도.
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString), true
	}

	// blocks 배열 형태 시도.
	var blocks []transcriptContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		parts := make([]string, 0, len(blocks))
		for _, b := range blocks {
			if b.Type != "text" {
				continue
			}
			t := strings.TrimSpace(b.Text)
			if t != "" {
				parts = append(parts, t)
			}
		}
		if len(parts) == 0 {
			return "", true
		}
		return strings.Join(parts, " "), true
	}

	return "", false
}

// normalizeSingleLine 은 연속된 공백·줄바꿈을 단일 공백으로 합친다. 사이드바
// 카드는 한 줄 미리보기라 multi-line 텍스트가 들어오면 layout이 무너진다.
func normalizeSingleLine(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	lastWasSpace := false
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' || r == ' ' {
			if !lastWasSpace && b.Len() > 0 {
				b.WriteByte(' ')
				lastWasSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastWasSpace = false
	}
	out := b.String()
	return strings.TrimSpace(out)
}

// truncateChars 는 rune 단위로 maxChars를 넘지 않도록 자른다. 잘린 경우
// 말줄임 기호(`…`)를 끝에 붙인다. UTF-8 멀티바이트 안전.
func truncateChars(s string, maxChars int) string {
	if maxChars <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == maxChars {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
