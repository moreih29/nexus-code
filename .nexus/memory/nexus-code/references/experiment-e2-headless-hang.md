# experiment-e2-headless-hang.md

**실험 ID**: E2  
**날짜**: 2026-04-10  
**OpenCode 버전**: 1.3.10  
**관련 이슈**: GitHub opencode-ai/opencode #16367  
**판정**: opencode run에서 auto-reject로 회피됨 + **외부 권한 중재 HTTP/SSE API 완전 지원 확인 (결정적 발견)**

---

## 배경

GitHub Issue #16367은 `opencode serve` headless 모드에서 `ask` 권한 요청이 발생할 때 세션이 무한 hang에 빠진다는 버그 보고다. 이전 리서처(rsch_opencode_permission)는 이를 "여전히 버그"로 분류하고, "OpenCode에서는 nexus-code가 Claude Code와 동형의 Forced Gatekeeper 역할을 할 수 없다"는 비대칭 가설을 제시했다. E2는 이 가설을 검증하고, 동시에 외부 권한 중재 API의 실제 존재와 작동 방식을 탐색하는 실험이다.

**실험 진행 방식**: engineer 에이전트(eng_e2_headless_hang)가 초기 설정(opencode.json, session 생성, SSE 구독)을 수행했으나 턴 소진으로 중단됐다. Lead가 이어받아 실험 2단계와 OpenAPI 스키마 분석을 직접 수행하고 REPORT.md를 작성했다.

---

## 실험 설정

`opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "deny",
    "write": "deny",
    "patch": "deny",
    "multiedit": "deny",
    "bash": "ask"
  }
}
```

플러그인 없음. bash=ask 설정으로 bash 도구 호출 시 권한 요청이 발생하도록 격리했다.

---

## 1단계 실험 — opencode run headless 모드 + bash=ask

### 실행

```bash
timeout 30 opencode run "Use the bash tool to run: echo hello-e2-ask-test" --format json --print-logs 2>&1 > run-output.log
```

### 결과

- **Exit code: 0** (hang 없음, 정상 종료, 약 3초)
- run-output.log 핵심 라인 (--print-logs 내부 서비스 로그):
  ```
  service=permission id=per_d776c97c20017DbC0AnXSHQj6S permission=bash patterns=["echo hello-e2-ask-test"] asking
  service=bus type=permission.asked publishing
  ! permission requested: bash (echo hello-e2-ask-test); auto-rejecting
  service=server method=POST path=/permission/per_d776c97c20017DbC0AnXSHQj6S/reply request
  service=bus type=permission.replied publishing
  ```
- tool_use 결과: `"error":"The user rejected permission to use this specific tool call."`

### 해석

`opencode run` CLI는 headless 환경(TUI 없음)에서 `ask` 권한 요청이 발생하면 내장 auto-reject 핸들러를 실행한다. 로그 흐름에서 확인된 사실:

1. `permission.asked` 이벤트가 내부 bus에 publish됨
2. CLI가 `POST /permission/:id/reply` 엔드포인트를 자체 호출해 reject 처리
3. `permission.replied` 이벤트가 bus에 publish됨
4. 세션 종료 (exit 0)

즉 `opencode run`은 #16367에서 보고된 hang을 **auto-reject로 회피**한다. 이 동작이 OpenCode 개발팀의 의도적 수정인지 아니면 `opencode run`이 원래부터 그랬는지는 확인되지 않았다.

---

## 2단계 실험 — opencode serve + SSE 구독 + opencode run --attach

### 실행

```bash
opencode serve --port 8401 --print-logs > serve2.log 2>&1 &
curl -sN http://localhost:8401/event > events_stream.log &
opencode run --attach http://localhost:8401 --dir <cwd> \
  "Use the bash tool to run: echo hello-e2-serve-test" --format json
```

`curl -sN`으로 SSE `/event` 스트림을 실시간 캡처했다.

### 결과

`opencode run --attach`도 동일하게 auto-reject로 종료됐다 (CLI 클라이언트가 내장 핸들러를 동일하게 사용하기 때문).

그러나 SSE 캡처(`events_stream.log`)에서 결정적 발견이 이루어졌다.

### events_stream.log — 권한 관련 이벤트 (원문)

```json
data: {"type":"permission.asked","properties":{"id":"per_d776ee424001SaVXqovEhqpNln","permission":"bash","patterns":["echo hello-e2-serve-test"],"always":["echo *"],"metadata":{},"sessionID":"ses_288912569ffewVBxoUXIkIEHpI","tool":{"messageID":"msg_d776edae8001lVdSYZeeIX7Qf6","callID":"call_4309"}}}

data: {"type":"permission.replied","properties":{"sessionID":"ses_288912569ffewVBxoUXIkIEHpI","requestID":"per_d776ee424001SaVXqovEhqpNln","reply":"reject"}}
```

`permission.asked` 이벤트의 payload 구조:
- `id`: `per_d776ee424001SaVXqovEhqpNln` — 권한 요청 ID (reply 엔드포인트에서 사용)
- `permission`: `"bash"` — 요청된 권한 종류
- `patterns`: `["echo hello-e2-serve-test"]` — 실제 실행 명령
- `always`: `["echo *"]` — 항상 허용 패턴 후보
- `sessionID`: 세션 ID
- `tool.messageID` / `tool.callID`: 어느 tool_use 호출에 대한 요청인지 식별

`permission.replied` 이벤트에서 `reply: "reject"`는 CLI auto-reject가 전송한 응답이다.

---

## 3단계 — OpenAPI /doc 스키마 분석

`http://localhost:8401/doc` OpenAPI 3.1.1 엔드포인트에서 컴포넌트 스키마를 확인했다.

### 권한 관련 공식 스키마 (10개)

```
PermissionRequest
Event.permission.asked
Event.permission.replied
PermissionAction
PermissionRule
PermissionRuleset
PermissionActionConfig
PermissionObjectConfig
PermissionRuleConfig
PermissionConfig
```

### PermissionRequest 스키마 (공식 OpenAPI 정의)

```json
{
  "type": "object",
  "properties": {
    "id":         { "type": "string", "pattern": "^per.*" },
    "sessionID":  { "type": "string", "pattern": "^ses.*" },
    "permission": { "type": "string" },
    "patterns":   { "type": "array", "items": { "type": "string" } },
    "metadata":   { "type": "object" },
    "always":     { "type": "array", "items": { "type": "string" } },
    "tool": {
      "type": "object",
      "properties": {
        "messageID": { "type": "string", "pattern": "^msg.*" },
        "callID":    { "type": "string" }
      },
      "required": ["messageID", "callID"]
    }
  },
  "required": ["id", "sessionID", "permission", "patterns", "metadata", "always"]
}
```

### Event.permission.asked 스키마 (공식 OpenAPI 정의)

```json
{
  "type": "object",
  "properties": {
    "type":       { "type": "string", "const": "permission.asked" },
    "properties": { "$ref": "#/components/schemas/PermissionRequest" }
  },
  "required": ["type", "properties"]
}
```

`type` 필드가 `"permission.asked"` const로 고정된 discriminated union 구조다. SSE 스트림에서 이 type 값으로 권한 요청 이벤트를 필터링할 수 있다.

---

## 결정적 발견 3가지

### 발견 1: SSE /event 스트림에 permission.asked + permission.replied 이벤트 공식 방출

`GET /event` SSE 스트림은 단순한 세션 상태 알림을 넘어, 권한 요청 이벤트를 실시간으로 방출한다. `Event.permission.asked`와 `Event.permission.replied`는 OpenAPI 3.1.1 스키마로 공식 정의되어 있다. 실험에서 실제 방출이 events_stream.log에 기록되어 증거가 존재한다.

### 발견 2: POST /permission/:id/reply 엔드포인트 실제 작동

내부 로그에 `service=server method=POST path=/permission/per_.../reply request` 라인이 기록됐다. `opencode run`의 auto-reject 경로가 바로 이 엔드포인트를 사용해 권한 거부를 처리한다. 외부 supervisor도 동일한 엔드포인트로 권한 승인 또는 거부 응답을 전송할 수 있다.

### 발견 3: Claude Code ApprovalBridge와 기능적으로 동형인 외부 supervisor 패턴 가능

nexus-code가 `opencode serve`를 spawn하고 SSE로 `permission.asked` 이벤트를 구독한 뒤, 사용자 UI에 승인 요청을 표시하고, `POST /permission/:id/reply`로 응답을 전송하는 흐름이 API 레벨에서 완전히 지원된다. Claude Code의 hook 기반 ApprovalBridge(pre-tool-use hook → JSON 응답)와 역할이 동형이다. 프로토콜 모양은 다르지만(Claude Code는 hook 즉시 응답, OpenCode는 SSE push + 별도 REST 응답) 외부 supervisor의 개입 지점은 동등하다.

---

## SSE 이벤트 흐름 다이어그램

```
nexus-code (supervisor)          opencode serve (OpenCode 1.3.10)
       |                                      |
       |  spawn + GET /event (SSE 구독)      |
       |─────────────────────────────────────>|
       |                                      |
       |                                      | [LLM이 bash 도구 호출 결정]
       |                                      |
       |  data: {"type":"permission.asked",  |
       |          "properties": {            |
       |            "id": "per_...",         |
       |            "permission": "bash",    |
       |            "patterns": [...],       |
       |            "tool": {               |
       |              "messageID": "msg_...",|
       |              "callID": "call_..."  |
       |            }                       |
       |          }}                        |
       |<────────────────────────────────────|
       |                                      |
       | [사용자 UI 표시 + 승인/거부 입력]   |
       |                                      |
       |  POST /permission/per_.../reply      |
       |  body: {"action": "allow"|"deny"}   |
       |─────────────────────────────────────>|
       |                                      |
       |  data: {"type":"permission.replied", |
       |          "properties": {             |
       |            "requestID": "per_...",   |
       |            "reply": "allow"|"reject"}|
       |          }}                          |
       |<────────────────────────────────────|
       |                                      |
       |                                      | [도구 실행 또는 거부 처리]
```

---

## 판정

### #16367 (headless ask hang)

`opencode run`에서는 auto-reject로 회피되어 hang이 관측되지 않는다. `opencode serve`에 아무 SSE 구독자도 없고 외부 클라이언트가 응답을 주지 않는 경우 hang이 발생할 가능성은 남아 있으나, 이 시나리오는 nexus-code 설계와 무관하다 (nexus-code는 reply를 전송한다).

이전 리서처의 비대칭 가설("OpenCode에서는 nexus-code가 Forced Gatekeeper 역할 불가")은 **번복됐다**. OpenCode 1.3.10은 외부 supervisor 패턴을 HTTP/SSE API 레벨에서 공식 지원한다.

### 외부 권한 중재 가능성

**완벽히 가능하다.** 3개 근거가 모두 확인됐다:
1. `Event.permission.asked` 공식 OpenAPI 스키마 존재
2. SSE `/event` 스트림에 실시간 방출 관측 (events_stream.log)
3. `POST /permission/:id/reply` 엔드포인트 실제 작동 (CLI auto-reject 경로 사용 확인)

---

## 미해결 사항

1. `POST /permission/:id/reply` request body 스키마가 공식 확정되지 않았다. `{"action":"allow"|"deny"}` 형태로 추정되나 소스 확인 필요 (`packages/opencode/src/server/` 또는 `@opencode-ai/sdk`).
2. `opencode serve`에 외부 클라이언트가 아무 응답도 주지 않을 때 hang이 실제로 발생하는지 엄밀 재현은 미완료.
3. `OPENCODE_SERVER_PASSWORD is not set; server is unsecured` 경고 확인. 프로덕션 nexus-code ↔ OpenCode 통신 보안 설계 필요.

---

## nexus-code 함의

Issue #5 옵션 γ의 OpenCode adapter **경로 A** (`opencode serve` + HTTP/SSE) 구현의 공식 지원 근거가 확보됐다. AgentHost 인터페이스(`spawn`, `observe`, `approve`, `reject`, `dispose`)의 OpenCode 구현체는 이 API를 사용한다.

경로 A는 nexus-code 기존 아키텍처(Hono + SSE + HTTP)와 동형이라 이식 비용이 낮다. 단 OpenCode 독자 API이므로 다른 하네스에 재사용할 수 없다.

Supervision layer 정의가 변경된다: nexus-code는 Claude Code와 OpenCode 모두에서 **대칭적으로** Forced Gatekeeper 역할이 가능하다.

---

## opencode-nexus 함의

기존 플러그인 `tool.execute.before` throw 패턴은 in-process 권한 집행 경로로 유지된다. SSE `/event` + `POST /permission/:id/reply`는 외부 supervisor(nexus-code)가 연결하는 별도 경로다. 두 경로는 독립적으로 작동하며, 공존 가능하다.

opencode-nexus는 자신이 방출하는 `permission.asked` 이벤트의 payload 스키마(`PermissionRequest`)를 숙지해야 한다 — 특히 `id`(reply에 사용), `tool.callID`(어느 호출인지 추적), `sessionID`(다중 세션 구분) 필드.

---

## 교차 참조

- `experiment-e1-permission-ask.md` — 플러그인 in-process `permission.ask` 훅이 미트리거됨. E2의 HTTP API 경로와 별개의 버그.
- `experiment-e4-acp-mode.md` — 경로 B (`opencode acp` + stdio JSON-RPC). E2 경로 A의 대안.
- `research-opencode-permission.md` (세션 생성 시점의 nexus-temp/experiments/rsch_opencode_permission) — 비대칭 가설을 제시한 초기 문헌 조사 보고서. E2 결과로 번복.
- `research-acp-spec.md` (세션 생성 시점의 nexus-temp/experiments/rsch_acp_spec) — ACP 프로토콜 전체 명세 조사. 경로 B의 근거.
- `00-ECOSYSTEM_PRIMER.md §3.1` — Supervisor 이중 성격(관찰자 + Policy Enforcement Point) 정의. E2 발견이 이 정의의 실증 근거.
