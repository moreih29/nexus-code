# research-acp-spec.md

> **세션**: plan session #1, nexus-temp, 2026-04-10
> **조사 에이전트**: Researcher (rsch_acp_spec)
> **조사 트리거**: 실험 E4(eng_e4_acp_mode)가 프로토콜 오해로 초기 단계 실패. rsch_acp_spec이 공백을 완전히 보완.
> **교차 참조**: `experiment-e4-acp-mode.md`, `research-claude-code-acp.md`

---

## 조사 대상

1. ACP(Agent Client Protocol)의 정체 — 기원, 거버넌스, 현재 버전, 기반 기술
2. OpenCode의 `opencode acp` 명령 — 실행 방식, 권한 중재 구조
3. nexus-code ProcessSupervisor와의 구조적 호환성 평가

---

## 조사 경로

| 단계 | 방법 | 대상 |
|------|------|------|
| 1단계 | Context7 문서 조회 | ACP 공식 명세, OpenCode ACP 구현 |
| 2단계 | WebFetch | `agentclientprotocol.com/protocol/schema` |
| 2단계 | WebFetch | `github.com/agentclientprotocol/agent-client-protocol` |
| 3단계 | 소스 분석 | `packages/opencode/src/acp/agent.ts` (anomalyco/opencode fork) |
| 3단계 | 이슈 조회 | GitHub Issue #17920, #13752, PR #13750 |

증거 분류 기호: **[P]** primary (직접 관측), **[S]** secondary (문헌), **[T]** tertiary (전달된 보고), **[Inference]** 추론

---

## ACP 일반 명세

### 기원과 거버넌스 [S]

Agent Client Protocol(ACP)은 Zed Industries가 자사 에디터(Zed)와 AI 에이전트 통합을 위해 주도했으나, 이후 에디터 종속성을 제거하고 **독립 오픈 표준**으로 분리되었다.

- 공식 GitHub 조직: `agentclientprotocol/agent-client-protocol`
- 현재 버전: **v0.11.5** (릴리즈 날짜: 2026-04-09)
- 총 릴리즈 수: 36개
- 거버넌스: 커뮤니티 거버넌스 (`GOVERNANCE.md` 존재)
- 라이선스: 오픈 표준 (특정 벤더 종속 없음)

### 공식 스펙 URL [S]

```
agentclientprotocol.com/protocol/schema
```

### 기반 기술 [S]

```
JSON-RPC 2.0 over stdio (nd-JSON)
```

- 에디터(또는 호스트 프로세스)가 **클라이언트** 역할
- AI 에이전트가 **서버** 역할
- 에디터가 에이전트를 서브프로세스로 spawn하고, stdin/stdout으로 nd-JSON 형식 메시지를 교환

---

## 메시지 구조 개요

### 클라이언트 → 에이전트 (요청) [S]

| 메서드 | 설명 |
|--------|------|
| `initialize` | 세션 초기화 |
| `session/new` | 신규 세션 생성 |
| `session/load` | 기존 세션 로드 |
| `session/list` | 세션 목록 조회 |
| `session/prompt` | 사용자 프롬프트 전송 |
| `session/cancel` | 진행 중인 세션 취소 |
| `session/set_config_option` | 세션 설정 변경 |
| `session/set_mode` | 세션 모드 변경 |

### 에이전트 → 클라이언트 (요청/알림) [S]

| 메서드 | 설명 |
|--------|------|
| `fs/read_text_file` | 파일 읽기 요청 |
| `fs/write_text_file` | 파일 쓰기 요청 |
| `session/request_permission` | **권한 중재 요청 (핵심)** |
| `session/update` | 세션 상태 업데이트 (스트리밍 진행 상황) |
| `terminal/*` | 터미널 관련 작업 |

`session/request_permission`은 에이전트가 민감한 작업 전에 클라이언트(에디터 또는 호스트)에 사용자 승인을 요청하는 핵심 메서드다.

---

## 지원 에디터 [S]

| 에디터 | 지원 형태 |
|--------|-----------|
| Zed | 네이티브 내장 |
| Neovim | CodeCompanion 등 여러 플러그인 |
| VS Code | 확장 플러그인 |
| JetBrains AI Assistant | 플러그인 |
| Emacs | 플러그인 |
| Obsidian | 플러그인 |
| Unity | 플러그인 |
| Chrome ACP | 브라우저 확장 |

---

## 지원 에이전트 [S]

| 에이전트 | ACP 지원 상태 |
|----------|---------------|
| Claude Code | Zed 어댑터 경유 (네이티브 미지원, 상세는 `research-claude-code-acp.md` 참조) |
| Gemini CLI | 지원 |
| Goose | 지원 |
| OpenCode | 네이티브 지원 (`opencode acp` 명령) |
| Codex | 진행 중 |
| Aider | 진행 중 |

---

## OpenCode `opencode acp` 명령

### 실행 방식 [S]

```bash
opencode acp [--cwd path]
```

- OpenCode를 **ACP 규격 서브프로세스**로 기동
- 호스트(에디터 또는 nexus-code)가 spawn 후 **stdin/stdout JSON-RPC** 메시지 교환
- 별도 HTTP 포트를 열지 않음 (stdio 전용)

**주의**: E4 실험에서 `opencode acp --port 17890`으로 실행을 시도했으나, ACP는 HTTP 포트 서버가 아닌 stdio JSON-RPC 방식이므로 실험이 초기 단계에서 종료되었다. 이 오해를 rsch_acp_spec이 정정했다. [T/S]

### 지원 기능 [S]

`opencode acp` 모드에서 작동하는 기능:
- 내장 도구 (bash, edit, write 등)
- MCP 서버 연동
- 권한 시스템 (`opencode.json` 정책)
- `AGENTS.md` 파일 로드
- 에이전트 계층 (서브에이전트 포함)

미지원:
- `/undo`, `/redo` 슬래시 커맨드

---

## 권한 요청 구조

### `packages/opencode/src/acp/agent.ts` 분석 [P/S]

OpenCode ACP 모드의 권한 중재 흐름:

1. OpenCode 내부에서 `permission.asked` 이벤트 발생
2. `handleEvent()` 함수가 이를 캐치
3. ACP 연결로 `session/request_permission` 호출 (클라이언트에 전달)
4. 클라이언트(에디터 또는 호스트)가 사용자에게 UI 표시 후 응답 반환
5. `res.outcome`에 따라 허용 또는 거부 처리

---

## RequestPermissionRequest 스키마 [S]

```json
{
  "sessionId": "string",
  "toolCall": "ToolCallUpdate",
  "options": ["PermissionOption"]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `sessionId` | string | 현재 세션 ID |
| `toolCall` | ToolCallUpdate | 권한 요청을 발생시킨 도구 호출 정보 |
| `options` | PermissionOption[] | 사용자에게 제시할 선택지 목록 |

---

## RequestPermissionResponse 스키마 [S]

```json
{
  "outcome": {
    "cancelled": true
    // 또는
    "selected": { "optionId": "string" }
  }
}
```

클라이언트는 `cancelled`(사용자가 취소) 또는 `selected`(특정 옵션 선택) 중 하나를 반환한다.

---

## PermissionOptionKind [S]

| 값 | 의미 |
|----|------|
| `allow_once` | 이번 한 번만 허용 |
| `allow_always` | 항상 허용 (정책 추가) |
| `reject_once` | 이번 한 번만 거부 |
| `reject_always` | 항상 거부 (정책 추가) |

---

## Question tool 버그

### 버그 상세 [S]

ACP 모드에서 `question.asked` 이벤트에 대한 핸들러가 없다.

- `permission.asked` 이벤트: 핸들러 있음 → `session/request_permission` 호출 → 정상 작동
- `question.asked` 이벤트: **핸들러 없음** → 응답 없이 무한 hang

관련 이슈:
- **GitHub Issue #17920**: ACP 모드에서 question tool hang 보고
- **GitHub Issue #13752**: 관련 이슈 추적
- **PR #13750**: `question.asked`를 `requestPermission` 경로로 변환하는 수정 진행 중

**진행 상태 (조사 시점 기준)**: PR #13750 미머지. ACP 모드에서 question tool 사용 시 hang 발생 위험 존재.

**실용적 영향**: nexus-code가 ACP 모드로 OpenCode를 제어할 경우, OpenCode가 question tool을 사용하는 시나리오에서 프로세스가 멈출 수 있다. 이 버그가 해소되기 전까지는 ACP 경로(경로 B) 채택 시 주의가 필요하다.

---

## nexus-code ProcessSupervisor 호환성 판정

**판정: 중간(조건부 가능)**
**확신 수준: 높음(문헌 기반)**

### 구조적 동형성 [Inference]

| 항목 | Claude Code ProcessSupervisor | ACP (opencode acp) |
|------|-------------------------------|---------------------|
| 실행 방식 | 부모가 CLI를 spawn | 부모가 서브프로세스를 spawn |
| 통신 채널 | stdin/stdout | stdin/stdout |
| 프로토콜 | stream-json (독자 포맷) | JSON-RPC 2.0 (표준) |
| 권한 중재 | ApprovalBridge (독자) | `session/request_permission` (표준) |

두 패턴은 **spawn + stdin/stdout** 구조에서 동형이다. nexus-code의 기존 ProcessSupervisor 아키텍처(프로세스 spawn, stdout 파이프, 권한 응답 주입)는 ACP로 포팅 가능하다. 필요한 것은 **프로토콜 어댑터 작성** — stream-json 파싱 대신 JSON-RPC 2.0 파싱, ApprovalBridge 응답 대신 `session/request_permission` 응답 형식 구현.

### 조건부 사항 [Inference]

- question tool hang 버그(#17920, PR #13750) 해소 전까지는 ACP 경로에서 question tool 사용 시나리오에 위험 존재
- 실제 실행 검증(E4 단계)이 미완료 상태이므로 확신 수준은 문헌 기반에 한정

---

## Lead 해석

rsch_acp_spec 보고를 수신한 Lead는 다음과 같이 해석했다: [T]

**옵션 γ(추상화 인터페이스 + 멀티 어댑터)** 채택 시, OpenCode 어댑터의 두 후보 경로:

- **경로 A**: `opencode serve` + HTTP/SSE — E2에서 실제 작동이 확인된 경로. nexus-code 기존 Hono 서버 아키텍처와 동형이라 이식 비용이 낮다. 더 안전한 기본 선택.
- **경로 B**: `opencode acp` + stdio JSON-RPC — 이 문서의 조사 대상. ProcessSupervisor 구조와 동형이고 오픈 표준이라는 장기적 이점이 있으나, question tool 버그 해소 전까지는 위험 요소가 있다. 미래 선택지.

Lead 초기 추천: 경로 A를 기본으로 구현하고, PR #13750 머지 이후 경로 B로 마이그레이션 검토. [Inference]

---

## 교차 참조

- `experiment-e4-acp-mode.md` — ACP 실험 초기 실패 경위 (프로토콜 오해 기록)
- `research-claude-code-acp.md` — Claude Code의 ACP 지원 형태 및 Zed 어댑터 상세
- `research-opencode-permission.md` — OpenCode 권한 모델 전반 (플러그인 in-process + HTTP 경로)

---

*출처 분류: [P] primary(직접 관측) / [S] secondary(문헌) / [T] tertiary(전달) / [Inference] 추론*
*문서 버전: plan session #1, 2026-04-10*
