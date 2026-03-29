<!-- tags: protocol, stream-json, cli, ipc, hooks, permissions -->
# stream-json Protocol

Claude Code CLI `--output-format stream-json` 프로토콜 동작 참조.

## 메시지 타입

| 타입 | 설명 |
|------|------|
| `system` (init) | 세션 초기화, session_id 포함 |
| `stream_event` | API SSE 이벤트 래핑 (text_delta 등). 유일한 실시간 텍스트 소스 |
| `assistant` | 완성된 메시지. tool_use 블록 추출 전용 |
| `tool_result` | 도구 실행 결과 (type:"user" 내부 tool_result 블록) |
| `result` | 턴 완료. total_cost_usd, duration_ms, usage 포함 |
| `rate_limit_event` | API rate limit. CLI 자동 재시도 |

## 텍스트 스트리밍

- `stream_event` (content_block_delta → text_delta)가 유일한 실시간 소스
- `assistant`의 텍스트는 완성본 — 실시간 스트리밍에 사용 안 함
- `streamedTextLength` 카운터로 비스트리밍 fallback 방어
- `--verbose` 필수 (`--output-format stream-json` 사용 시)

## 퍼미션 처리

퍼미션은 stdout에 나타나지 않음. 별도 메커니즘:

1. settings.json 정적 규칙 (매칭 시 훅 미호출)
2. PreToolUse 훅 (정적 미매칭 시 호출)
3. 기본: -p 모드는 거부

**exit code 2 = 도구 차단** (M5 검증). `--dangerously-skip-permissions`에서도 동작.

훅 형식: `{"matcher": "...", "hooks": [{"type": "command", "command": "..."}]}` (중첩 배열 필수)

## Sub-Agent 훅

- stream-json에 agent 구분 정보 없음 (단일 플랫 스트림)
- PreToolUse 훅의 `agent_id` 필드로 parent/sub-agent 구분
- SubagentStart/SubagentStop 훅으로 생명주기 추적
- parent agent: agent_id 필드 없음 / sub-agent: agent_id 포함

## 에러 복구

| Exit Code | 의미 | 재시작 |
|-----------|------|--------|
| 0 | 정상 종료 | 안 함 |
| 1 | 일반 에러 | 3회 시도 (1s, 2s, 4s backoff) |
| 129 | Orphan | 무조건 재시작 |
| 130 | SIGINT (취소) | 안 함 |

Activity timeout: 120초. rate limit 대기 중 타임아웃 미발생.

## IPC 매핑

| CLI 메시지 | IPC 채널 | Store 액션 |
|-----------|----------|------------|
| stream_event (text_delta) | stream:text-chunk | appendTextChunk() |
| assistant (tool_use) | stream:tool-call | addToolCall() |
| tool_result | stream:tool-result | resolveToolCall() |
| result | stream:turn-end | flushStreamBuffer() + endSession() |

## 제약사항

1. stdin은 user 타입 메시지만 전송 가능 (tool_result 주입 불가)
2. AskUserQuestion은 -p 모드에서 즉시 is_error:true 반환 → 새 user message로 우회
3. --resume 시 이전 대화 stdout 재전송 없음
4. tool_call 이벤트는 도구 실행 후 도착 (실행 전 인터셉트는 HookServer 필요)