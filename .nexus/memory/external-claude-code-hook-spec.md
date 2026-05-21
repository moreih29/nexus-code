# Claude Code Hook Spec — Anthropic 공식 1차 출처 확정본

작성일: 2026-05-21
조사 범위: code.claude.com/docs (docs.anthropic.com → code.claude.com 301 리다이렉트 확인됨)
용도: T2(래퍼 settings JSON) 및 T6(main hookHandler) 구현 레퍼런스

---

## 항목 1: preferredNotifChannel

### (a) 답

키 이름은 정확히 `preferredNotifChannel` (camelCase).

유효 값 (공식 문서 명시):
- `"auto"` — 기본값. iTerm2·Ghostty·Kitty에서는 데스크톱 알림, 그 외 터미널에서는 아무것도 하지 않음
- `"terminal_bell"` — 모든 터미널에서 벨 문자(bell char) 울림
- `"iterm2"` — iTerm2 전용 알림
- `"iterm2_with_bell"` — iTerm2 알림 + 벨
- `"kitty"` — Kitty 터미널 알림
- `"ghostty"` — Ghostty 터미널 알림
- `"notifications_disabled"` — **알림 완전 비활성화**

OSC 알림 끄는 값: `"notifications_disabled"` 가 맞음. cmux가 사용하던 값과 동일하나 공식 문서에서 직접 확인됨.

설정 가능 레벨: user(`~/.claude/settings.json`) / project(`.claude/settings.json`) / local(`.claude/settings.local.json`) 모두 가능. 우선순위는 managed > CLI args > local > project > user 순.

### (b) 출처
- URL: https://code.claude.com/docs/en/settings
- URL: https://code.claude.com/docs/en/terminal-config

### (c) 인용 발췌
> "Method for task-complete and permission-prompt notifications: `"auto"`, `"terminal_bell"`, `"iterm2"`, `"iterm2_with_bell"`, `"kitty"`, `"ghostty"`, or `"notifications_disabled"`. Default: `"auto"`, which sends a desktop notification in iTerm2, Ghostty, and Kitty and does nothing in other terminals."
— code.claude.com/docs/en/settings [P]

---

## 항목 2: hooks 객체 lifecycle 이벤트

### (a) 답

공식 문서에 정의된 전체 hook 이벤트 목록 (7종 + 추가):

| 이벤트명 | 발사 시점 | 차단 가능 |
|---|---|---|
| `SessionStart` | 세션 시작 또는 재개 시 | No (exit 2는 stderr 표시만) |
| `UserPromptSubmit` | 사용자가 프롬프트 제출 시, Claude 처리 전 | Yes |
| `PreToolUse` | 도구 호출 실행 직전 | Yes |
| `PermissionRequest` | 권한 다이얼로그가 표시될 때 | Yes (allow/deny) |
| `Notification` | Claude Code가 알림을 보낼 때 | No |
| `Stop` | Claude가 응답 완료 시 | Yes |
| `SessionEnd` | 세션 종료 시 | No |
| `PostToolUse` | 도구 호출 성공 후 | Yes (decision: block) |
| `PostToolUseFailure` | 도구 호출 실패 후 | — |
| `PermissionDenied` | auto mode classifier가 거부 시 | — |
| `Setup` | `--init-only`, `--init`, `--maintenance` 플래그로 시작 시 | — |
| `StopFailure` | API 오류로 턴 종료 시 | No |
| `UserPromptExpansion` | 슬래시 커맨드가 프롬프트로 확장될 때 | Yes |
| `PostToolBatch` | 병렬 도구 호출 배치 전체 완료 후 | — |
| `SubagentStart` / `SubagentStop` | 서브에이전트 생성/종료 시 | — |
| `TaskCreated` / `TaskCompleted` | TaskCreate 도구로 태스크 생성/완료 시 | — |
| `TeammateIdle` | 에이전트 팀 팀원이 유휴 상태로 전환 직전 | — |
| `InstructionsLoaded` | CLAUDE.md 또는 `.claude/rules/*.md` 로드 시 | — |
| `ConfigChange` | 설정 파일이 세션 중 변경될 때 | Yes |
| `CwdChanged` | 작업 디렉토리 변경 시 | — |
| `FileChanged` | 감시 파일이 디스크에서 변경될 때 | — |
| `WorktreeCreate` / `WorktreeRemove` | 워크트리 생성/제거 시 | — |
| `PreCompact` / `PostCompact` | 컨텍스트 압축 전/후 | — |
| `Elicitation` / `ElicitationResult` | MCP 서버가 사용자 입력 요청 시 | — |

**질문에서 열거한 7종 검증:**
- `SessionStart` — 존재함
- `UserPromptSubmit` — 존재함
- `PreToolUse` — 존재함
- `Notification` — 존재함
- `Stop` — 존재함
- `SessionEnd` — 존재함
- `PermissionRequest` — 존재함

**모두 공식 hook 이벤트로 확인됨.**

### hook schema

기본 구조:
```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolName|OtherTool",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "timeout": 600,
            "async": false
          }
        ]
      }
    ]
  }
}
```

`{matcher: string, hooks: [{type, command, timeout?, async?}]}` 형태 **맞음**.

단, `type`은 `"command"` 외에도 `"http"`, `"mcp_tool"`, `"prompt"`, `"agent"` 가 존재함.

**timeout 단위: 초(seconds).** 밀리초 아님.

기본 timeout:
- command/http/mcp_tool: 600초
- prompt: 30초
- agent: 60초
- UserPromptSubmit의 command/http/mcp_tool: 30초 (별도 낮춤)

**async 필드 의미:**
- `async: true` — 백그라운드 실행, Claude 응답을 블로킹하지 않음
- `asyncRewake: true` — 백그라운드 실행 + exit code 2로 종료 시 Claude에 인터럽트 발생, `async: true`를 암시함

### (b) 출처
- URL: https://code.claude.com/docs/en/hooks
- URL: https://code.claude.com/docs/en/hooks-guide

### (c) 인용 발췌
> "async: If true, runs in background without blocking the session."
> "asyncRewake: If true, runs in background and wakes Claude on exit code 2. Implies async."
> "All timeout values use SECONDS, not milliseconds."
— code.claude.com/docs/en/hooks [P]

---

## 항목 3: `claude --settings` 플래그

### (a) 답

`--settings` 플래그는 **파일 경로 또는 인라인 JSON 문자열 둘 다** 받는다.

병합 방식: **additive overlay** (덮어쓰기 아님)
- `--settings`에서 지정한 키는 `settings.json` 파일의 동일 키를 오버라이드
- 지정하지 않은 키는 파일 기반 값을 그대로 유지
- 세션 내에서만 적용되며 파일에 저장되지 않음

공식 설명: "Values you set here override the same keys in your settings.json files for this session. Keys you omit keep their file-based values."

### (b) 출처
- URL: https://code.claude.com/docs/en/cli-reference

### (c) 인용 발췌
> `--settings` — Path to a settings JSON file or an inline JSON string. Values you set here override the same keys in your settings.json files for this session. Keys you omit keep their file-based values. See settings precedence.
— code.claude.com/docs/en/cli-reference [P]

---

## 항목 4: `claude --session-id` 플래그

### (a) 답

`--session-id <uuid>` 플래그 **존재함.** 유효한 UUID를 받아야 함.

공식 설명: "Use a specific session ID for the conversation (must be a valid UUID)"

**인터랙티브 세션에서의 동작:**
공식 문서는 `-p`(print mode)와 인터랙티브 모드에서의 차이를 다음과 같이 설명:
- `-p` 모드: `--session-id`가 로컬 영속화 ID를 제어함 (`.jsonl` 파일명이 주입된 UUID로 명명됨)
- 인터랙티브 모드: `--session-id`는 API/텔레메트리 ID를 설정하지만, CLI는 로컬 영속화용으로 자체 UUID를 생성함

**한 PTY에서 동일 session-id로 여러 번 실행 시:**
- 공식 문서에서 이 케이스의 동작(resume vs 신규)을 명시적으로 기술하지 않음
- 세션 재개는 `--resume <session-id>` 또는 `--continue`를 사용하는 것이 공식 패턴
- 동일 세션을 두 터미널에서 fork 없이 resume하면 "messages from both interleave into one transcript"라는 경고가 있음

**결론:** `--session-id`는 존재하나, 인터랙티브 세션에서의 re-use 동작은 "Anthropic 공식 spec에서 확인되지 않음". 인터랙티브 세션 재개에는 `--resume <id>` 사용이 명시적 공식 패턴임.

### (b) 출처
- URL: https://code.claude.com/docs/en/cli-reference
- URL: https://code.claude.com/docs/en/sessions

### (c) 인용 발췌
> `--session-id` — Use a specific session ID for the conversation (must be a valid UUID)
— code.claude.com/docs/en/cli-reference [P]

> "If you resume the same session in two terminals without forking, messages from both interleave into one transcript."
— code.claude.com/docs/en/sessions [P]

---

## 항목 5: PermissionRequest hook 응답 형식

### (a) stdin payload schema

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test"
  },
  "tool_use_id": "tool_use_12345"
}
```

필드: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`

### (b) stdout 응답 형식

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

**유효한 `behavior` 값:**
- `"allow"` — 허용. 네이티브 다이얼로그 표시 없이 자동 승인
- `"deny"` — 거부

**"passthrough" 등가 값:**
공식 문서에서 `"passthrough"` 또는 `"ask"` 값은 PermissionRequest에 존재하지 않음. 네이티브 PTY 프롬프트로 넘기려면 **응답 생략 (exit 0 + 출력 없음)** 이 유일한 메커니즘.

공식 문서 명시:
> "Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow. The hook can deny the call, but staying silent doesn't approve it."

즉: **응답 생략 + exit 0 = 네이티브 다이얼로그 fallback**.

**exit code 2 동작:**
- exit 2 = 권한 거부 (deny). stderr 내용이 사용자에게 표시됨
- exit 0 + JSON = 구조화된 결정 처리

**timeout 시 동작:**
공식 문서에서 PermissionRequest hook timeout의 정확한 fallback 동작(deny/allow/hang/native prompt)을 **명시적으로 기술하지 않음.** HTTP hook 문서에서 "non-2xx, connection failures, and timeouts all produce non-blocking errors that allow execution to continue"라는 일반적 패턴이 있으나 PermissionRequest 전용 명시는 없음. → **"Anthropic 공식 spec에서 확인되지 않음"**

**ExitPlanMode / AskUserQuestion 커버 여부:**

공식 문서의 hooks-guide에서 ExitPlanMode를 PermissionRequest hook으로 처리하는 예제가 명시적으로 존재:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\": {\"hookEventName\": \"PermissionRequest\", \"decision\": {\"behavior\": \"allow\"}}}'"
          }
        ]
      }
    ]
  }
}
```

> "Skip the approval dialog for tool calls you always allow. This example auto-approves ExitPlanMode, the tool Claude calls when it finishes presenting a plan and asks to proceed"

PermissionRequest matcher 테이블에서 `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`는 모두 "tool name"으로 매칭함. PreToolUse 매처 예시 목록에 `AskUserQuestion`과 `ExitPlanMode`가 명시됨. PermissionRequest도 같은 tool name 기반 매칭 사용.

**결론: ExitPlanMode는 명확히 커버됨 (공식 예제 존재). AskUserQuestion은 같은 메커니즘으로 커버되어야 하나 PermissionRequest 전용 예제는 없음.**

추가로 응답에 `updatedPermissions`로 세션 permission mode 전환도 가능:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
      ]
    }
  }
}
```

### (c) 출처
- URL: https://code.claude.com/docs/en/hooks
- URL: https://code.claude.com/docs/en/hooks-guide

### (d) 인용 발췌
> "A PermissionRequest hook fires when Claude Code is about to show a permission dialog, and returning 'behavior': 'allow' answers it on your behalf."
— code.claude.com/docs/en/hooks-guide [P]

> "Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow."
— code.claude.com/docs/en/hooks-guide [P]

---

## 항목 6: Notification hook payload 필드

### (a) 답

공식 문서에서 확인된 Notification hook stdin 필드:

**공통 입력 필드 (모든 hook에 포함):**
- `session_id` — 세션 고유 ID
- `transcript_path` — 트랜스크립트 JSONL 파일 경로
- `cwd` — 작업 디렉토리
- `hook_event_name` — `"Notification"`

**Notification 전용 필드:**
- `notification_type` — 알림 유형. 유효 값: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`
- `message` — 알림 메시지 텍스트 (공식 예제에서 `jq -r '.message // "Needs your attention"'`로 파싱하는 패턴 존재)

**`title` 필드:** 공식 문서 payload 스키마에서 명시적 언급 없음 — "Anthropic 공식 spec에서 확인되지 않음"

공식 예제 (terminal-config 페이지):
```bash
input=$(cat)
title="Claude Code"
body=$(jq -r '.message // "Needs your attention"' <<<"$input")
seq=$(printf '\033]777;notify;%s;%s\007' "$title" "$body")
jq -nc --arg seq "$seq" '{terminalSequence: $seq}'
```
→ `message` 필드 사용, `title`은 하드코딩으로 처리 (payload에서 오는 것 아님)

Notification hook 응답: 차단 불가(decision 없음), 사이드 이펙트 전용. `terminalSequence` 출력으로 터미널 OSC 시퀀스 주입 가능.

### (b) 출처
- URL: https://code.claude.com/docs/en/hooks
- URL: https://code.claude.com/docs/en/terminal-config

### (c) 인용 발췌
> "notification_type: Type of notification. Values: permission_prompt, idle_prompt, auth_success, elicitation_dialog, elicitation_complete, elicitation_response"
> "message: The notification message"
— code.claude.com/docs/en/hooks [P]

---

## 요약: cmux 관찰값과의 비교

| cmux 사용값 | 공식 확인 여부 | 비고 |
|---|---|---|
| `preferredNotifChannel` 키 이름 | 확인됨 | 정확히 일치 |
| `notifications_disabled` 값 | 확인됨 | 공식 문서에 명시 |
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Notification` / `Stop` / `SessionEnd` | 모두 확인됨 | |
| `PermissionRequest` | 확인됨 | |
| `{matcher, hooks: [{type, command, timeout, async}]}` 스키마 | 확인됨 | |
| timeout 단위 = 초 | 확인됨 | |
| `permissionDecision: "passthrough"` | **확인되지 않음** | PermissionRequest에는 없음. 응답 생략(exit 0 + no output)이 유일한 native prompt fallback |
| ExitPlanMode가 PermissionRequest로 커버 | 확인됨 | 공식 예제 존재 |

---

## Implementation Impact (T2 / T6 결정 사항)

### T2: 래퍼 settings JSON

1. **`preferredNotifChannel: "notifications_disabled"`** — 키/값 모두 공식 확인됨. Electron 인앱 PTY에서 OSC 알림 끄기 위해 이 값을 사용하면 됨. `--settings` 플래그로 inline JSON 또는 파일 경로 모두 전달 가능하며 additive overlay로 동작하므로 사용자 기존 설정 보존됨.

2. **hook 스키마 변경 불필요** — `{matcher, hooks: [{type, command, timeout, async}]}` 구조가 공식 spec과 일치함. timeout 단위를 밀리초로 오해한 구현이 있다면 초 단위로 수정 필요.

3. **`--settings` 플래그 사용 패턴 확정** — `claude --settings '{"preferredNotifChannel":"notifications_disabled","hooks":{...}}'` 형태 또는 임시 파일 경로 모두 유효.

### T6: main hookHandler

4. **PermissionRequest "passthrough" 값 없음** — cmux가 사용하던 `permissionDecision: "passthrough"` 또는 유사 값은 PermissionRequest에 존재하지 않음. 네이티브 PTY 프롬프트로 fallback하려면 **exit 0 + 출력 없음(응답 생략)**이 유일한 메커니즘. hookHandler에서 "사용자에게 묻기" 경로는 응답을 아무것도 쓰지 않고 exit 0으로 종료하도록 구현해야 함.

5. **PermissionRequest timeout fallback 불명확** — 공식 spec에서 timeout 시 deny/allow/native prompt 중 무엇이 발생하는지 명시하지 않음. 안전한 구현을 위해 hookHandler는 timeout 전에 반드시 응답을 보내도록 설계해야 하며, 기본 timeout(600초)에 의존하지 말고 명시적 timeout 값을 짧게 설정할 것을 권장.

---

## 인용 1차 출처 목록

1. https://code.claude.com/docs/en/hooks — Hook 레퍼런스 전체 스키마 [P]
2. https://code.claude.com/docs/en/hooks-guide — Hook 활용 가이드 + PermissionRequest 예제 [P]
3. https://code.claude.com/docs/en/settings — preferredNotifChannel 포함 전체 설정 목록 [P]
4. https://code.claude.com/docs/en/cli-reference — --settings, --session-id 플래그 명세 [P]
5. https://code.claude.com/docs/en/terminal-config — preferredNotifChannel 사용 예시 + Notification hook [P]
6. https://code.claude.com/docs/en/sessions — --session-id vs --resume 동작 차이 [P]

모두 code.claude.com (= Anthropic 공식 운영 Claude Code 문서 사이트, docs.anthropic.com에서 301 리다이렉트됨) 소속.
