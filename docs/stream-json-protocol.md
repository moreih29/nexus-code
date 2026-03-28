# stream-json 프로토콜 엣지케이스 문서

> Claude Code CLI의 `--output-format stream-json` 프로토콜 동작, 엣지케이스, 복구 정책을 정리한 문서.
> M1 통신 안정화 과정에서 도출된 분석 결과를 반영한다.

---

## 1. 메시지 타입 전체 목록

CLI가 stdout으로 출력하는 NDJSON 메시지 타입. 한 줄에 하나의 JSON 객체가 출력된다.

### 1.1 핵심 메시지 타입

| 타입 | 발생 시점 | 설명 |
|------|----------|------|
| `system` | 세션 시작 직후 | 세션 초기화. `subtype: "init"` + `session_id` 포함 |
| `stream_event` | 응답 생성 중 (실시간) | Anthropic API의 SSE 이벤트를 래핑. 텍스트 스트리밍의 primary 소스 |
| `assistant` | 응답 완료 시 | 완성된 assistant 메시지. tool_use 블록 포함 |
| `tool_result` | 도구 실행 후 | 도구 실행 결과. `tool_use_id`로 tool_call과 매칭 |
| `result` | 턴 완료 시 | 비용(`total_cost_usd`), 소요 시간(`duration_ms`) 포함 |

### 1.2 부가 메시지 타입

| 타입 | 발생 시점 | 설명 |
|------|----------|------|
| `rate_limit_event` | API rate limit 도달 시 | CLI가 자동 재시도함. `retry_after_ms` 포함 가능 |
| `system` (subtype: `compact_boundary`) | 컨텍스트 압축 시 | CLI가 내부적으로 대화 컨텍스트를 압축했음을 알림 |
| `system` (subtype: `status`) | CLI 상태 변경 시 | 내부 상태 정보 (디버그용) |

### 1.3 스트리밍 세부 이벤트 (stream_event 내부)

`stream_event`는 `event` 필드에 Anthropic API의 SSE 이벤트를 래핑한다:

| event.type | 설명 |
|------------|------|
| `content_block_delta` | 텍스트/도구 입력 스트리밍. `delta.type: "text_delta"` 시 `delta.text`에 텍스트 조각 |
| `content_block_start` | 콘텐츠 블록 시작 |
| `content_block_stop` | 콘텐츠 블록 종료 |
| `message_start` | 메시지 시작 |
| `message_delta` | 메시지 메타데이터 업데이트 |
| `message_stop` | 메시지 종료 |

### 1.4 result 이벤트 usage 필드 (M5 T8 확인)

`result` 이벤트는 턴 레벨 집계 정보만 제공한다:

```json
{
  "type": "result",
  "total_cost_usd": 0.0234,
  "duration_ms": 12500,
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567
  }
}
```

**제약:** 개별 LLM API 호출별 토큰/비용 세분화는 불가능하다. `result` 이벤트는 전체 턴의 집계값만 제공하며, 멀티-에이전트 세션에서 개별 sub-agent 호출별 비용을 분리할 수 없다.

### 1.6 최상위 fallback 이벤트

`content_block_start`, `content_block_delta`, `content_block_stop`, `message_start`, `message_delta`, `message_stop`이 `stream_event` 래핑 없이 최상위에 직접 올 수 있다. 현재 무시 처리.

### 1.7 퍼미션 처리

퍼미션 처리는 stdout stream-json에 나타나지 않으며, 별도 메커니즘으로 동작한다.

#### 퍼미션 결정 우선순위

```
1. settings.json / --allowedTools / --disallowedTools  (정적 규칙, 매칭되면 2번 미호출)
2. --permission-prompt-tool 또는 PermissionRequest 훅  (정적 규칙 미매칭 시만 호출)
3. 기본: 인터랙티브 모드는 사용자에게 묻기, -p 모드는 거부
```

#### --permission-prompt-tool (MCP 기반)

**MCP 도구 이름**을 `mcp__{server_name}__{tool_name}` 형식으로 전달해야 한다. 셸 명령이 아님.

```bash
claude -p "task" \
  --mcp-config '{"mcpServers": {"myserver": {"command": "node", "args": ["server.mjs"]}}}' \
  --permission-prompt-tool mcp__myserver__permission_prompt
```

MCP 도구 입력/출력 (커뮤니티 역공학, 공식 문서 미비):
- 입력: `{ tool_use_id, tool_name, input }`
- 출력: `{ behavior: "allow" | "deny", updatedInput?, message? }`

#### PreToolUse 훅

settings.json의 `hooks.PreToolUse`로 설정. 도구 실행 전에 호출됨.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "curl -sf -X POST '...' -d @-" }]
    }]
  }
}
```

훅 입력 (stdin): `{ hook_event_name, session_id, tool_name, tool_input, tool_use_id, permission_mode, cwd }`

**검증된 사실:**
- `PermissionRequest`는 유효한 훅 이벤트가 아님 (호출되지 않음)
- `PreToolUse` 훅은 `--dangerously-skip-permissions`와 함께 사용 시 호출됨
- `-p` 모드의 기본 퍼미션 시스템은 훅보다 먼저 동작하여, 퍼미션 거부 시 훅이 호출되지 않음
- 따라서 `--dangerously-skip-permissions`로 내장 퍼미션을 우회한 뒤, PreToolUse 훅에서 자체 퍼미션 로직을 실행하는 구조

#### 현재 Nexus Code 상태 — 퍼미션 enforcement 미해결

**현재 구현:**
- `--dangerously-skip-permissions` + `PreToolUse` 훅(settings.local.json) + HookServer
- HookServer가 auto-approve 또는 PermissionCard UI 표시 → 사용자 승인/거부
- 퍼미션 카드 UI, diff 뷰, Split Button 승인 범위(once/session/permanent)는 모두 동작

**M5 실험에서 검증된 사실 (exit code 2 차단):**
- settings.json의 PreToolUse 훅에서 **exit code 2를 반환하면 도구 실행이 차단됨** (M5 T8 실험으로 직접 확인)
- `--dangerously-skip-permissions` 모드에서도 exit code 2 차단이 정상 동작함
- 차단 시 Claude는 "Edit 도구가 사용자 설정 hook에 의해 차단되었습니다" 메시지를 반환
- exit code 0 = 허용, exit code 2 = 차단, 기타 non-zero = 에러 (무시 가능성 있음)

**훅 형식 주의사항 (M5 T8 실험 확인):**
- 올바른 형식 (중첩 배열): `{"matcher": "...", "hooks": [{"type": "command", "command": "..."}]}`
- 구 형식 (인식 안 됨): `{"matcher": "...", "command": "..."}` — hooks 배열 없이 command 직접 지정 시 미동작

**해결 방향:**
1. **exit code 2 기반 차단** — HookServer가 deny 결정 시 exit code 2로 응답 (M5에서 구현 가능 확인)
2. **--permission-prompt-tool + MCP 도구** — Nexus 플러그인에 permission_prompt 도구 추가
3. **Agent SDK 전환** — CLI 프로세스 대신 Agent SDK(TypeScript) 사용 (canUseTool 콜백으로 네이티브 처리)

---

## 2. 메시지 수신 순서

### 2.1 일반 텍스트 응답

```
system (init)
  → stream_event (content_block_delta, text_delta) × N
  → assistant (완성된 메시지)
  → result (비용/시간)
```

### 2.2 도구 사용 포함 응답

```
system (init)
  → stream_event (text_delta) × N          ← 텍스트 부분
  → assistant (text + tool_use 블록)        ← 완성된 메시지
  → user (content: [{ type: "tool_result", tool_use_id, content, is_error }])
                                            ← 도구 실행 결과 (type:"user" 안에 포함!)
  → stream_event (text_delta) × N          ← 후속 텍스트
  → assistant                               ← 후속 완성 메시지
  → result
```

**주의:** `tool_result`는 별도 NDJSON 타입이 아니라, `type: "user"` 메시지의 `message.content[]` 배열 안에 `type: "tool_result"` 블록으로 포함된다.

### 2.3 AskUserQuestion 동작 (-p 모드)

`-p` (print) 모드에서 `AskUserQuestion` 도구는 인터랙티브 입력이 불가능하므로, CLI가 즉시 에러로 반환한다:

```
assistant (tool_use: AskUserQuestion, input: { questions: [...] })
  → user (content: [{ type: "tool_result", tool_use_id, content: "Answer questions?", is_error: true }])
  → assistant (후속 응답 — 에러를 인지하고 계속 진행)
```

**GUI 래퍼 대응 (우회 방식):**

이 에러는 예상된 동작이므로 에러로 표시하지 않는다. StatusBar에서 질문+옵션 버튼을 표시하고, 사용자 클릭 시 `sendResponse()`로 새 메시지를 전송한다. 대화 영역에는 AskUserQuestion ToolCard를 표시하지 않는다 (TodoWrite와 동일 패턴).

전송 포맷: `"[AskUserQuestion] {질문} → {선택한 옵션}"` — Claude가 맥락을 이해할 수 있도록 질문과 답변을 함께 전송.

**stdin tool_result 직접 주입은 불가능:**

`--resume` + `--input-format stream-json`으로 tool_use 대기 세션을 재개하면, CLI가 stdin을 읽기 전에 `"No response requested."` 합성 메시지를 자동 주입 → API가 `"unexpected tool_use_id found in tool_result blocks"` 에러 반환. ([GitHub #16712](https://github.com/anthropics/claude-code/issues/16712), Open)

`--input-format stream-json` 프로토콜 자체가 미문서화 상태. ([GitHub #24594](https://github.com/anthropics/claude-code/issues/24594), Not Planned으로 종료)

**근본적 해결:** Claude Agent SDK (TypeScript)의 `canUseTool` 콜백을 사용하면 AskUserQuestion을 네이티브로 처리 가능. CLI 프로세스 스폰 방식 자체를 SDK로 전환해야 하므로 별도 마일스톤 필요.

### 2.4 TURN_END vs SESSION_END 상태 관리

- **TURN_END**: 턴 종료. 세션은 계속될 수 있으므로 StatusBar 상태(todos, askQuestion)를 유지한다. `clearAll()` 호출하지 않음.
- **SESSION_END**: 세션 완전 종료. StatusBar `clearAll()` 호출하여 모든 상태 초기화.

### 2.5 rate limit 발생 시

```
stream_event × N
  → rate_limit_event (retry_after_ms)       ← CLI가 대기 시작
  → [대기]
  → stream_event × N                        ← CLI 자동 재시도 성공 후 계속
  → assistant
  → result
```

### 2.4 세션 재개 (--resume)

```
system (init, 동일 session_id)
  → [이전 대화 내용은 stdout으로 재전송되지 않음]
  → [새 프롬프트 대기 또는 이전 턴 계속]
```

---

## 3. 텍스트 스트리밍 파이프라인

### 3.1 텍스트 소스 단일화 원칙

**`stream_event` (content_block_delta → text_delta)가 유일한 실시간 텍스트 소스.**

`assistant` 메시지의 `message.content[].text`는 완성된 텍스트를 포함하지만, 실시간 스트리밍에는 사용하지 않는다. `assistant`는 tool_use 블록 추출 전용.

### 3.2 streamedTextLength 안전장치

`StreamParser`는 `streamedTextLength` 카운터로 비스트리밍 응답을 방어한다:

```
stream_event 수신 시:
  streamedTextLength += delta.text.length
  emit('text_chunk', { text: delta.text })

assistant 수신 시:
  if (streamedTextLength === 0):
    // stream_event가 한 번도 오지 않은 경우 — fallback으로 텍스트 emit
    emit('text_chunk', { text: block.text })
  streamedTextLength = 0  // 다음 턴 리셋
```

이 fallback은 매우 짧은 응답에서 `stream_event` 없이 `assistant`만 오는 이론적 케이스를 대비한다.

### 3.3 --include-partial-messages 제거 이유

이 플래그는 `assistant` 메시지를 스트리밍 도중 반복 emit하여 `streamedTextLength` 카운터 방어를 무력화했다:

1. 스트리밍 중 partial `assistant` 도착 → `streamedTextLength > 0`이므로 skip
2. partial `assistant` 핸들러 끝에서 `streamedTextLength = 0` 리셋
3. 이후 `stream_event` 계속 도착 → 카운터 다시 증가
4. 다음 partial `assistant` 도착 → `streamedTextLength > 0`이므로 skip, 다시 리셋
5. 최종 `assistant` 도착 시 타이밍에 따라 `streamedTextLength === 0`이면 전체 텍스트를 다시 emit → **중복**

**해결:** `--include-partial-messages` 제거. `stream_event`가 실시간 텍스트를 제공하므로 partial assistant 메시지는 불필요.

### 3.4 --verbose 필수 플래그

`--verbose`는 `--output-format stream-json` 사용 시 필수. 없으면 CLI가 `stream-json requires --verbose` 에러로 exit 1. 제거 불가.

---

## 4. 에러 복구 시나리오

### 4.1 Exit Code 분류

| Exit Code | 의미 | 재시작 여부 |
|-----------|------|------------|
| 0 | 정상 종료 | 재시작 안 함 |
| 1 | 일반 에러 | 재시작 시도 |
| 129 | Orphan 프로세스 (부모 사망) | 재시작 시도 (무조건) |
| 130 | SIGINT (사용자 취소) | 재시작 안 함 |
| 기타 | 알 수 없는 에러 | 재시작 시도 (보수적) |

### 4.2 자동 재시작 정책

- **최대 시도:** 3회
- **백오프:** exponential — 1초, 2초, 4초
- **재시작 방법:** `--resume <sessionId>`로 동일 세션 복원
- **성공 판정:** `_session_id_ready` 이벤트 수신 (15초 타임아웃)
- **3회 초과:** `restart_failed` 이벤트 emit → UI에서 error 상태 표시, 사용자에게 수동 재시작 CTA 제공

### 4.3 재시작 시 상태 전이

```
running → [crash, exitCode !== 0]
  → restarting (1초 대기)
  → running (재시작 성공)
  → idle (턴 완료)

running → [crash, 3회 초과]
  → error (UI에서 수동 재시작 유도)
```

### 4.4 재시작 카운터 리셋

`turn_end` 이벤트 수신 시 `restartCount`를 0으로 리셋. 즉, 한 번이라도 정상 턴이 완료되면 재시작 카운터가 초기화되어 다음 크래시에서 다시 3회 시도 가능.

### 4.5 ChatPanel resume 역할 분담

| 레이어 | 역할 |
|--------|------|
| RunManager (main) | 프로세스 크래시 감지 → 자동 --resume 재시작 (3회, backoff) |
| ChatPanel (renderer) | PROMPT IPC 실패 시 (sessions Map에 없음) → START + --resume fallback |

RunManager가 자동 재시작을 처리하므로, ChatPanel의 resume은 RunManager 재시작도 실패한 최후의 수단.

---

## 5. 타임아웃 / Rate Limit

### 5.1 Activity Timeout

- **기본값:** 120초 (ACTIVITY_TIMEOUT_MS)
- **측정 기준:** 마지막 stdout 데이터 수신 이후 경과 시간
- **리셋 트리거:** `text_chunk`, `tool_call`, `tool_result` 이벤트 수신 시
- **타임아웃 발생 시:** `timeout` 이벤트 emit → SessionStatus를 `'timeout'`으로 변경 → UI에서 안내 표시

### 5.2 Rate Limit 처리

CLI가 API rate limit에 도달하면 `rate_limit_event`를 emit하고 자동으로 재시도한다.

**타이머 연동:**
1. `rate_limit_event` 수신 → `rateLimited = true`, activity timer 정지
2. 다음 stdout 데이터 수신 → `rateLimited = false`, activity timer 재시작
3. rate limit 대기 중에는 타임아웃이 발생하지 않음

이 설계는 CLI의 자동 재시도를 타임아웃으로 오인하는 것을 방지한다.

### 5.3 SessionStatus 전체 값

| Status | 의미 |
|--------|------|
| `idle` | 대기 중 (입력 가능) |
| `running` | CLI가 응답 생성 중 |
| `waiting_permission` | 도구 퍼미션 대기 |
| `restarting` | 크래시 후 자동 재시작 중 |
| `timeout` | 응답 없음 (120초 초과) |
| `ended` | 세션 종료 (정상) |
| `error` | 에러 상태 (재시작 실패 등) |

---

## 6. 알려진 제약사항

### 6.1 stdin 제약

stream-json stdin으로 전송 가능한 메시지는 `user` 타입뿐:

```json
{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "..."}]}}
```

도구 실행 제어, 중단 요청 등은 stdin으로 불가. 프로세스 시그널(SIGINT)로만 제어.

### 6.2 tool_call 이벤트 타이밍

`tool_call` 이벤트는 도구 *실행 후*에 도착한다. 즉, 도구 실행 전에 인터셉트하려면 `--permission-prompt-tool` 훅(HookServer)을 사용해야 한다.

### 6.3 --verbose 필수

`--output-format stream-json` 사용 시 `--verbose` 플래그 필수. 없으면 exit 1.

### 6.4 --resume 동작

- `--resume <sessionId>` 시 이전 대화 내용이 stdout으로 재전송되지 않음
- `system (init)` 메시지는 동일하게 수신됨 (동일 session_id)
- 이전 컨텍스트는 CLI 내부적으로 복원되며, 새 프롬프트를 stdin으로 전송하면 이전 대화를 이어감

### 6.5 Orphan 프로세스 감지

부모 프로세스(Electron) 사망 시 CLI 자식 프로세스는 exit code 129로 종료. 단, 감지까지 최대 30초 딜레이 발생 가능.

### 6.6 JSON 파싱 실패

`--verbose` 모드에서 간헐적으로 non-JSON 텍스트가 stdout에 섞일 수 있음. `StreamParser.parseLine()`에서 `JSON.parse` 실패 시 경고 로그 + `error` 이벤트 emit 후 해당 라인 skip.

---

## 7. Sub-Agent 훅 이벤트 (M5 T8 실험 검증)

### 7.1 stream-json에 sub-agent 구분 정보 없음

stream-json 출력은 단일 플랫 스트림으로, parent/sub-agent 계층 정보를 포함하지 않는다. GitHub Issue #14859 (OPEN)에서 `agent_id` 필드 추가가 요청 중이나 미구현 상태. Sub-agent 구분은 훅 이벤트 기반으로만 가능하다.

### 7.2 PreToolUse 훅의 agent_id 필드

PreToolUse 훅 payload에서 `agent_id` 필드로 parent/sub-agent를 구분할 수 있다:

| 호출 주체 | agent_id 필드 | session_id |
|-----------|---------------|------------|
| Parent agent | 없음 (필드 미포함) | 세션 고유값 |
| Sub-agent 내부 도구 호출 | 포함 (예: `"aba8e55c512c5d4a5"`) | Parent와 동일 값 공유 |

```json
// sub-agent가 도구를 호출할 때의 PreToolUse payload 예시
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc123",
  "agent_id": "aba8e55c512c5d4a5",
  "tool_name": "Edit",
  "tool_input": { ... },
  "tool_use_id": "toolu_xxx",
  "permission_mode": "dangerouslySkipPermissions",
  "cwd": "/path/to/project"
}
```

### 7.3 SubagentStart / SubagentStop 훅

Sub-agent 생명주기를 추적하는 훅 이벤트. `--dangerously-skip-permissions` 모드에서도 정상 호출됨.

**SubagentStart payload:**
```json
{
  "hook_event_name": "SubagentStart",
  "session_id": "abc123",
  "agent_id": "aba8e55c512c5d4a5",
  "agent_type": "subagent"
}
```

**SubagentStop payload** (SubagentStart 필드 + 추가):
```json
{
  "hook_event_name": "SubagentStop",
  "session_id": "abc123",
  "agent_id": "aba8e55c512c5d4a5",
  "agent_type": "subagent",
  "permission_mode": "dangerouslySkipPermissions",
  "agent_transcript_path": "/path/to/transcript.jsonl",
  "last_assistant_message": "작업이 완료되었습니다.",
  "stop_hook_active": false
}
```

**활용:** AgentTimeline에서 sub-agent 노드 분리 시 `SubagentStart` → `SubagentStop` 구간을 `agent_id`로 그룹핑하고, 해당 구간의 PreToolUse `agent_id`와 매칭하면 sub-agent 도구 호출을 계층적으로 분리할 수 있다.

---

## 8. IPC 채널 매핑

CLI stdout 이벤트가 renderer에 전달되는 경로:

| CLI 메시지 | StreamParser 이벤트 | IPC 채널 | Renderer 처리 |
|-----------|--------------------|---------|--------------|
| `stream_event` (text_delta) | `text_chunk` | `stream:text-chunk` | `appendTextChunk()` |
| `assistant` (tool_use) | `tool_call` | `stream:tool-call` | `addToolCall()` |
| `tool_result` | `tool_result` | `stream:tool-result` | `resolveToolCall()` |
| `result` | `turn_end` | `stream:turn-end` | `flushStreamBuffer()` + `endSession()` |
| `rate_limit_event` | `rate_limit` | `stream:rate-limit` | (로깅) |
| (프로세스 close) | `session_end` | `stream:session-end` | `flushStreamBuffer()` + `endSession()` |
| (재시작 시도) | `restart_attempt` | `stream:restart-attempt` | `setStatus('restarting')` |
| (재시작 실패) | `restart_failed` | `stream:restart-failed` | `setStatus('error')` |
| (타임아웃) | `timeout` | `stream:timeout` | (UI 안내) |

---

## 9. 데이터 흐름 요약

```
                          ┌─────────────────────────────────────────────────┐
                          │                  Main Process                   │
                          │                                                 │
  stdin (user msg)        │   RunManager                                    │
  ──────────────────►     │     │                                           │
                          │     ├── spawn('claude', [...args])              │
                          │     │     stdout ──► StreamParser.feed()        │
                          │     │                  │                        │
                          │     │                  ├── 'text_chunk'  ──►    │
                          │     │                  ├── 'tool_call'   ──►    │
                          │     │                  ├── 'tool_result' ──►    │ IPC send
                          │     │                  ├── 'turn_end'   ──►    │────────►
                          │     │                  ├── 'rate_limit' ──►    │
                          │     │                  └── 'session_id' ──►    │
                          │     │                                           │
                          │     ├── activityTimer (120s)                    │
                          │     ├── shouldRestart(exitCode)                 │
                          │     └── doRestart() (--resume, 3회 backoff)     │
                          └─────────────────────────────────────────────────┘
                                                    │
                                              IPC channels
                                                    │
                          ┌─────────────────────────▼───────────────────────┐
                          │                Renderer Process                  │
                          │                                                 │
                          │   ipc-bridge.ts                                 │
                          │     └── window.electronAPI.on(channel, handler) │
                          │           │                                     │
                          │           ▼                                     │
                          │   session-store.ts (Zustand)                    │
                          │     ├── appendTextChunk()                       │
                          │     ├── addToolCall()                           │
                          │     ├── resolveToolCall()                       │
                          │     ├── flushStreamBuffer()                     │
                          │     └── setStatus()                             │
                          │           │                                     │
                          │           ▼                                     │
                          │   ChatPanel.tsx (React)                         │
                          └─────────────────────────────────────────────────┘
```
