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

### 1.4 최상위 fallback 이벤트

`content_block_start`, `content_block_delta`, `content_block_stop`, `message_start`, `message_delta`, `message_stop`이 `stream_event` 래핑 없이 최상위에 직접 올 수 있다. 현재 무시 처리.

### 1.5 퍼미션 관련 (HookServer 경유)

`control_request` / `control_response`는 `--permission-prompt-tool` 훅을 통해 HTTP로 처리되며, stdout stream-json에는 나타나지 않는다.

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
  → tool_result                             ← 도구 실행 결과
  → stream_event (text_delta) × N          ← 후속 텍스트
  → assistant                               ← 후속 완성 메시지
  → result
```

### 2.3 rate limit 발생 시

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

## 7. IPC 채널 매핑

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

## 8. 데이터 흐름 요약

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
