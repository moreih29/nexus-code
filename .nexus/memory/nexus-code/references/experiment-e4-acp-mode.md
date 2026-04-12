# experiment-e4-acp-mode.md

**실험 ID**: E4  
**날짜**: 2026-04-10  
**OpenCode 버전**: 1.3.10  
**관련 이슈**: N/A (신규 탐색)  
**판정**: ACP 모드 존재 확인 + 권한 중재 경로 문헌 확정 — **실제 실행 검증은 미완료**

---

## 배경

이 실험은 버그 재현이 아니라 신규 경로 탐색이다. `opencode acp` 명령이 존재하는지, 그것이 stdio JSON-RPC 기반 Agent Client Protocol(ACP)을 통해 권한 중재를 지원하는지, 그리고 nexus-code의 ProcessSupervisor 패턴(spawn + stdio)과 구조적으로 호환되는지를 확인하는 목표였다.

배경: E2 실험에서 OpenCode의 HTTP/SSE 기반 권한 중재 API가 완전히 지원됨이 확인됐다(경로 A). E4는 그 대안인 경로 B — `opencode acp` stdio 기반 ACP 모드 — 의 실현 가능성을 별도 탐색하는 실험이다.

---

## 실험 진행 상황 및 미완료 이유

engineer 에이전트(eng_e4_acp_mode)가 `opencode acp --port 17890 --print-logs --log-level DEBUG` 명령으로 실행을 시도했다.

이것은 프로토콜에 대한 **오해**다. ACP는 stdio JSON-RPC 기반 프로토콜이다. HTTP 포트 서버를 여는 것이 아니라, 에디터(클라이언트)가 프로세스를 spawn하고 stdin/stdout으로 JSON-RPC 메시지를 교환하는 방식이다. `--port` 플래그는 `opencode serve` 명령에 해당하는 옵션이지 `opencode acp`와 무관하다.

결과적으로 프로세스는 초기화 후 즉시 `disposing instance`로 종료됐다. stdin에서 ACP 초기화 메시지가 오지 않으면 프로세스가 종료되는 것이 정상 동작이다.

실제 stdio 프로토콜 캡처는 이 단계에서 이루어지지 않았다. acp-capture.log는 0바이트, acp-stderr.log에는 초기화 로그만 남았다.

이 공백을 researcher 에이전트(rsch_acp_spec)의 문헌 조사가 완전히 보완했다.

---

## acp-stderr.log (전체 — 실제 실행 증거)

```
INFO  2026-04-10T12:44:00 +623ms service=default version=1.3.10 args=["acp","--port","17890","--print-logs","--log-level","DEBUG"] opencode
INFO  2026-04-10T12:44:00 +1ms  service=default directory=/Users/kih/workspaces/areas/nexus-temp/experiments/e4-acp-mode creating instance
INFO  2026-04-10T12:44:00 +3ms  service=project directory=/Users/kih/workspaces/areas/nexus-temp/experiments/e4-acp-mode fromDirectory
INFO  2026-04-10T12:44:00 +5ms  service=db path=/Users/kih/.local/share/opencode/opencode.db opening database
INFO  2026-04-10T12:44:00 +12ms service=db count=10 mode=bundled applying migrations
INFO  2026-04-10T12:44:00 +5ms  service=default directory=/Users/kih/workspaces/areas/nexus-temp/experiments/e4-acp-mode bootstrapping
INFO  2026-04-10T12:44:00 +11ms service=config path=/Users/kih/.config/opencode/config.json loading
INFO  2026-04-10T12:44:00 +0ms  service=config path=/Users/kih/.config/opencode/opencode.jsonc loading
INFO  2026-04-10T12:44:00 +6ms  service=plugin name=CodexAuthPlugin loading internal plugin
INFO  2026-04-10T12:44:00 +0ms  service=plugin name=CopilotAuthPlugin loading internal plugin
INFO  2026-04-10T12:44:00 +1ms  service=plugin name=gitlabAuthPlugin loading internal plugin
INFO  2026-04-10T12:44:00 +0ms  service=plugin name=PoeAuthPlugin loading internal plugin
INFO  2026-04-10T12:44:00 +0ms  service=bus type=* subscribing
INFO  2026-04-10T12:44:00 +1ms  service=bus type=session.updated subscribing
INFO  2026-04-10T12:44:00 +1ms  service=bus type=message.updated subscribing
INFO  2026-04-10T12:44:00 +0ms  service=bus type=message.part.updated subscribing
INFO  2026-04-10T12:44:00 +0ms  service=bus type=session.diff subscribing
INFO  2026-04-10T12:44:00 +1ms  service=format init
INFO  2026-04-10T12:44:00 +1ms  service=lsp serverIds=deno, typescript, vue, ... enabled LSP servers
INFO  2026-04-10T12:44:00 +1ms  service=file init
INFO  2026-04-10T12:44:00 +3ms  service=file.watcher directory=... init
INFO  2026-04-10T12:44:00 +190ms service=file.watcher directory=... platform=darwin backend=fs-events watcher backend
INFO  2026-04-10T12:44:00 +2ms  service=bus type=command.executed subscribing
INFO  2026-04-10T12:44:00 +8ms  service=acp-command setup connection
INFO  2026-04-10T12:44:00 +2ms  service=default directory=... disposing instance
```

`service=acp-command setup connection` 라인이 기록됐다 — `opencode acp` 명령이 실제로 존재하고, OpenCode가 ACP 연결 셋업 단계까지는 도달했음을 확인한다. stdin 입력이 없어서 즉시 종료된 것이다.

---

## researcher 조사 결과 (rsch_acp_spec)

실험 공백을 보완한 researcher의 문헌 조사 결과를 요약한다.

### ACP 프로토콜 정체

- **Agent Client Protocol** — Zed Industries 주도로 시작했으나 독립 오픈 표준으로 분리됨
- 공식 조직: `agentclientprotocol/agent-client-protocol` (GitHub)
- 현재 버전: **v0.11.5** (2026-04-09 기준, 36개 릴리즈)
- 거버넌스: 커뮤니티 기반 (GOVERNANCE.md 존재)
- 공식 스펙: `agentclientprotocol.com/protocol/schema`
- 기반 프로토콜: **JSON-RPC 2.0 over stdio (nd-JSON)** — 에디터가 client, AI 에이전트가 server

### 지원 에디터 / 지원 에이전트

- 에디터: Zed(네이티브), Neovim(여러 플러그인), VS Code, JetBrains AI Assistant, Emacs, Obsidian, Unity, Chrome ACP
- 에이전트: Claude Code(Zed SDK 어댑터 경유), Gemini CLI, Goose, OpenCode(네이티브), Codex(진행 중), Aider(진행 중)

### opencode acp 명령 동작 방식

```bash
opencode acp [--cwd path]
```

에디터가 이 명령을 subproc으로 spawn한 뒤, stdin으로 JSON-RPC 메시지를 보내고 stdout nd-JSON을 수신한다. 내장 도구, MCP 서버, 권한 시스템, AGENTS.md, 에이전트 계층이 모두 ACP 모드에서 작동한다. `/undo`, `/redo` 슬래시 커맨드는 미지원.

### OpenCode ACP 권한 중재 구조

researcher가 `packages/opencode/src/acp/agent.ts` 소스를 분석한 결과:

1. OpenCode 내부 `permission.asked` 이벤트 발생
2. `handleEvent()` → ACP 연결로 `session/request_permission` 호출 (서버 → 클라이언트 방향)
3. 클라이언트(에디터 또는 nexus-code)가 사용자 UI를 표시하고 응답 반환
4. `res.outcome`에 따라 허용/거부 처리

### ACP 권한 스키마 (공식)

```json
RequestPermissionRequest: {
  "sessionId": string,
  "toolCall": ToolCallUpdate,
  "options": PermissionOption[]
}

RequestPermissionResponse: {
  "outcome": {
    "cancelled": {} | "selected": { "optionId": string }
  }
}

PermissionOptionKind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
```

### ACP question tool 버그

- `permission.asked` 이벤트: 핸들러 있음 → 정상 작동
- `question.asked` 이벤트: 핸들러 없음 → **무한 hang** (Issue #17920, #13752)
- PR #13750: `question.asked`를 `requestPermission` 경로로 변환하는 수정 진행 중 (2026-04-10 시점 미머지)

---

## 경로 B 아키텍처 다이어그램

```
nexus-code (ACP client)         opencode acp (stdio, ACP server)
       |                                      |
       | spawn("opencode acp")                |
       |─────────────────────────────────────>|
       |                                      |
       | initialize (JSON-RPC)               |
       |─────────────────────────────────────>|
       |<─────────────────────────────────────|
       |                                      |
       | session/new                         |
       |─────────────────────────────────────>|
       |                                      |
       | session/prompt {"text": "..."}      |
       |─────────────────────────────────────>|
       |                                      |
       | [LLM이 도구 호출 결정]               |
       |                                      |
       | session/request_permission           |
       | {"sessionId": ...,                  |
       |  "toolCall": ...,                   |
       |  "options": [...]}                  |
       |<─────────────────────────────────────|
       |                                      |
       | [사용자 UI 표시 + 입력]              |
       |                                      |
       | RequestPermissionResponse            |
       | {"outcome": {"selected": {          |
       |   "optionId": "allow_once"}}}       |
       |─────────────────────────────────────>|
       |                                      |
       | session/update (진행 상황)           |
       |<─────────────────────────────────────|
```

Claude Code ProcessSupervisor(spawn + stdin/stdout pipe)와 구조적으로 동형이다.

---

## 판정

**ACP 모드는 존재하고, 권한 중재 경로(`session/request_permission`)가 공식 지원된다. 그러나 engineer의 실제 실행 검증은 미완료다.**

- `opencode acp` 명령 존재: 확인 (acp-stderr.log의 `service=acp-command setup connection`)
- ACP 프로토콜 기반 권한 중재: 문헌으로 확인 (researcher 보고서)
- 실제 stdio 메시지 교환 검증: 미완료

이전 리서처의 "헤드리스 ACP는 stdin/stdout 기반으로 권한 중재가 가능할 수도"라는 추측은 researcher 조사로 사실로 확정됐다. 단 question tool hang 버그(PR #13750 진행 중)로 인해 모든 인터랙션이 완전 호환되는지는 불확실하다.

---

## 경로 A vs 경로 B 비교

| 항목 | 경로 A (E2 검증) | 경로 B (E4 문헌 조사) |
|------|---|----|
| 프로토콜 | HTTP/SSE + REST | stdio JSON-RPC 2.0 |
| 명령 | `opencode serve` | `opencode acp` |
| 실행 검증 | 완료 (events_stream.log, serve2.log) | 미완료 |
| 표준 | OpenCode 독자 API | 독립 오픈 표준 (ACP v0.11.5) |
| 이식성 | OpenCode 전용 | Gemini CLI, Goose, Codex 등 호환 |
| 기존 아키텍처 동형 | nexus-code Hono/SSE 패턴과 동형 | Claude Code ProcessSupervisor 패턴과 동형 |
| 알려진 버그 | POST /permission/:id/reply 스키마 미확정 | question tool hang (#17920) |

---

## nexus-code 함의

Issue #5 옵션 γ OpenCode adapter의 **경로 B** (`opencode acp` + stdio JSON-RPC)의 존재가 확인됐다.

**현재 권고**: 경로 A(E2에서 실행 검증 완료)를 기본 선택으로 한다. 경로 B는 다음 조건이 충족될 때 재평가 대상이다:
1. PR #13750 머지 (question tool hang 수정)
2. 실제 stdio 메시지 교환 프로토콜 캡처 검증

경로 B의 장기적 가치는 오픈 표준 레버리지에 있다. ACP를 지원하는 미래 에이전트(Codex, Aider 등)가 `opencode acp`와 동일한 인터페이스로 접속될 수 있다. 옵션 γ(추상화 인터페이스 + 멀티 어댑터) 전략 하에서 경로 B는 경로 A와 공존하는 대안 구현으로 준비할 수 있다.

AgentHost 인터페이스 설계 시 `spawn` 메서드가 HTTP/SSE와 stdio 양쪽을 지원하는 추상화로 정의되어야 한다.

---

## opencode-nexus 함의

opencode-nexus 자신의 ACP 구현 내부 구조를 숙지해야 한다. `packages/opencode/src/acp/agent.ts`의 `handleEvent()` 패턴이 어떻게 OpenCode 내부 이벤트를 ACP RPC 호출로 변환하는지 이해하면, 외부 ACP 클라이언트(nexus-code)와의 통합 설계에 직접 활용할 수 있다.

question tool hang 버그(#17920)의 상태를 추적해야 한다. PR #13750 머지 여부가 경로 B의 완전 호환 여부를 결정한다.

---

## 미완료 작업

engineer 수준의 실제 stdio 프로토콜 캡처 — `opencode acp` 프로세스를 spawn하고 stdin으로 JSON-RPC `initialize` → `session/new` → `session/prompt` 메시지를 순서대로 전송하며 stdout 응답을 캡처하는 실험 — 은 수행되지 않았다.

이 작업은 nexus-code OpenCode adapter 개발 시(경로 B 선택 시) 수행 예정이다.

---

## 교차 참조

- `experiment-e2-headless-hang.md` — 경로 A (`opencode serve` + HTTP/SSE). E4 경로 B의 실행 검증된 대안.
- `research-acp-spec.md` (세션 생성 시점의 nexus-temp/experiments/rsch_acp_spec) — ACP 프로토콜 전체 명세 및 OpenCode 구현 상세 조사. E4의 문헌 공백을 완전히 보완한 보고서.
- `research-claude-code-acp.md` (세션 생성 시점의 nexus-temp/experiments/rsch_acp_spec 또는 별도) — Claude Code 쪽 ACP는 Zed SDK 기반으로 구독제 호환이 불확실. §4.2 제약(Agent SDK 경로 금지)과 연결되는 확인 사항.
- `00-ECOSYSTEM_PRIMER.md §4.4` — "ACP로 Claude Code + OpenCode 통합 감독은 현재 불가능" 결정. 이 제약의 근거 중 하나가 E4 + researcher 조사 결과임.
- `00-ECOSYSTEM_PRIMER.md §4.3` — ProcessSupervisor + stream-json이 핵심 자산. 경로 B가 이 패턴과 구조적으로 동형임을 확인.
