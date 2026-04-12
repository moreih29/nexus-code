# research-opencode-permission.md

> **세션**: plan session #1, nexus-temp, 2026-04-10
> **조사 에이전트**: Researcher (rsch_opencode_permission)
> **보존 이유**: 리서처 조사 결과가 세션의 주요 전환점을 만들었으며, 이후 실험(E1~E3)에 의해 부분 번복·부분 유지됨. 원본 발견과 번복 모두 보존 필수.
> **교차 참조**: `experiment-e1-permission-ask.md`, `experiment-e2-headless-hang.md`, `experiment-e3-subagent-hook.md`, `research-acp-spec.md`

---

## 조사 대상

OpenCode의 권한 모델이 nexus-code의 Supervisor 패턴을 지원하는지 평가하기 위한 조사.
구체적으로 아래 3개 가설 시나리오를 검증 대상으로 설정했다.

**시나리오 A** — OpenCode는 Claude Code처럼 사용자와의 대화형 권한 중재(ask/approve 루프)를 지원한다.
즉, `permission.ask` 훅이 실제로 트리거되어 플러그인이 사용자에게 물어볼 수 있다.

**시나리오 B** — OpenCode는 대화형 중재를 지원하지 않는다. 권한은 정적 정책(`opencode.json`의 allow/ask/deny)으로만 집행되고, 외부 supervisor가 런타임에 개입할 여지가 없다.

**시나리오 C** — 책임 분할 모델. OpenCode는 정적 정책(플러그인 in-process) + 관찰(SSE 이벤트 스트림) 역할을 담당하고, nexus-code는 외부에서 이벤트를 수신해 권한 결정을 내린다.

---

## 조사 경로

| 단계 | 방법 | 대상 |
|------|------|------|
| 1단계 | Context7 문서 조회 | OpenCode 공식 문서, 플러그인 API |
| 1단계 | 내부 파일 분석 | `opencode-nexus/src/plugin/hooks.ts`, `src/pipeline/evaluator.ts` |
| 2단계 | WebSearch | OpenCode GitHub 이슈 목록, permission 관련 버그 보고 |
| 2단계 | GitHub 이슈 조회 | #7006, #16367, #5894 |
| 2단계 | opencode.json 명세 조회 | permission 키 구조 (allow/ask/deny) |

증거 분류 기호: **[P]** primary (직접 관측), **[S]** secondary (문헌·이슈), **[T]** tertiary (전달된 보고), **[Inference]** 추론

---

## 내부 파일 발견 (1단계)

### `opencode-nexus/src/plugin/hooks.ts` 분석 [P]

`tool.execute.before` 훅의 deny 처리는 `throw new Error(...)` 패턴만을 사용한다.
즉, 훅에서 예외를 던지면 도구 실행이 중단된다. 이는 플러그인이 도구를 차단하는 유일한 in-process 경로다.

`permission.ask` 훅은 해당 파일에 정의(인터페이스 선언)는 존재하지만, **실제로 트리거되는 코드 경로가 없다**. 함수 시그니처가 있으나 콜 사이트가 없는 상태.

### `src/pipeline/evaluator.ts` 분석 [P]

`editsAllowed` 플래그는 파이프라인 실행 상태 가드다. `editsAllowed === false`이면 파일 편집 도구 호출이 차단된다. 그러나 이것은 세션 시작 시 정적으로 결정되며, 실행 중 동적으로 변경되거나 외부 supervisor가 이를 제어하는 API가 없다.

**결론 (1단계)**: `editsAllowed`는 동적 권한 중재 메커니즘이 아니다. 정적 세션 구성 가드다.

---

## 외부 조사 결과 (2단계)

### opencode.json permission 키 구조 [S]

`opencode.json`의 `permissions` 블록은 도구별로 `allow`, `ask`, `deny` 세 가지 정책을 지정한다. 예:

```json
{
  "permissions": {
    "bash": "ask",
    "edit": "deny",
    "write": "deny"
  }
}
```

`ask`로 설정된 도구는 실행 전 사용자 확인을 요청하는 것이 의도된 동작이다.

### `tool.execute.before` throw 패턴 [P/S]

플러그인이 `tool.execute.before` 훅에서 `throw new Error(...)` 하면 도구 실행이 중단된다. 이것이 플러그인 in-process 권한 차단의 유일한 공식 경로다.

### `permission.ask` 훅 미트리거 버그 — GitHub Issue #7006 [S]

- **상태**: 미해결 (open)
- **내용**: `opencode.json`에서 도구를 `ask`로 설정해도 플러그인의 `permission.ask` 훅이 호출되지 않는다.
- **영향**: 플러그인 in-process에서 사용자에게 권한을 물어보는 대화형 루프가 불가능하다.

### headless 모드 `ask` 무한 hang 버그 — GitHub Issue #16367 [S]

- **상태**: 미해결 (open, 조사 시점 기준)
- **내용**: `opencode run` (headless/비대화형) 모드에서 도구가 `ask` 정책을 받으면 응답을 기다리며 무한 hang이 발생한다.
- **영향**: CI/CD 환경이나 외부 supervisor 없이 headless로 실행할 때 프로세스가 멈춘다.

### 서브에이전트 훅 미전파 버그 — GitHub Issue #5894 [S]

- **상태**: 미해결 ("보안 크리티컬"로 보고됨, 조사 시점 기준)
- **내용**: Primary 에이전트의 `tool.execute.before` 훅이 서브에이전트(task 도구로 spawn된 에이전트)에서 발생하는 도구 호출에는 전파되지 않는다.
- **영향**: 서브에이전트가 플러그인 훅을 우회해 도구를 실행할 수 있다. 보안 정책 집행에 구멍이 생긴다.

### OpenCode CLI 실행 모델 [S]

| 명령 | 설명 |
|------|------|
| `opencode` | 대화형 TUI 모드 |
| `opencode run <prompt>` | 비대화형(headless) 단일 프롬프트 실행 |
| `opencode serve` | HTTP 서버 모드 (REST API + SSE) |
| `opencode acp` | ACP(Agent Client Protocol) stdio 서브프로세스 모드 |

### 플러그인 로드 방식 [S]

OpenCode 플러그인은 **in-process 로드** 방식이다. OpenCode 런타임과 같은 프로세스 내에서 실행된다. 이것이 플러그인 경로와 HTTP API 경로를 구분하는 핵심 사실이다.

---

## 시나리오 판정

| 시나리오 | 내용 | 판정 |
|----------|------|------|
| A | OpenCode도 ask 대화형 가능 | **부정** |
| B | OpenCode는 비대화형(정적 정책만) | **부분 긍정** |
| C | 책임 분할(정적 정책 + 외부 관찰) | **근접** |

**시나리오 C 근접, 확신 수준: 중간**

근거:
- `permission.ask` 훅 미구현 (#7006) → 플러그인 단독으로 대화형 권한 중재 불가 [P/S]
- 서브에이전트 훅 전파 버그 (#5894) → 플러그인 경로 단독으로 Supervision 책임 완결 불가 [S]
- 단, HTTP/SSE 경로(`opencode serve`)의 권한 이벤트 방출 가능성은 이 시점에서 **미조사 상태**

확신 수준을 "높음"이 아닌 "중간"으로 표기한 이유: `opencode serve`의 외부 권한 중재 API 존재 여부가 조사되지 않았기 때문이다. 그 조사는 후속 실험(E2)에서 이루어졌다.

---

## Lead의 초기 해석

리서처 보고를 수신한 Lead는 다음 가설을 제시했다:

> "nexus-code의 Supervision 역할이 Claude Code(대화형 권한 중재 가능)와 OpenCode(정적 정책 집행 + 관찰자) 사이에서 **비대칭**할 것이다. Claude Code 쪽은 ApprovalBridge로 런타임 승인/거부를 처리하고, OpenCode 쪽은 `opencode.json` 정책 주입 + `tool.execute.before` 훅 기반 관찰자 역할이 현실적 최선이다."

이 해석은 #7006, #16367, #5894가 현존 버그라는 리서처 보고를 전제로 한 추론이었다. [Inference]

---

## 이후 실험으로 번복된 부분

**중요: 아래 내용은 리서처의 원본 조사 이후, 별도 실험(E1~E3)에서 수정·확장된 사실이다. 원본 조사의 오류가 아니라, 조사 시점의 불완전한 정보에서 시작해 실험이 보완한 것이다.**

### 번복 1: #5894 버그 현존 → 수정 확정 [E3 결과]

리서처는 #5894가 여전히 미해결이라고 보고했다 [S].
실험 E3는 OpenCode 1.3.10에서 이 버그가 **수정되었음을 확정**했다. [P]

`hook-trace.log` (E3):
```
[2026-04-10T12:42:58.044Z] TOOL_BEFORE tool=task sessionID=ses_288956bbfffeK6ggtFcuvNl2ZJ callID=call_7929
[2026-04-10T12:43:00.998Z] TOOL_BEFORE tool=bash sessionID=ses_288953f81ffefdA6muUeG0u31e callID=call_e1f2
```

Primary (`task`) + 서브에이전트 (`bash`) 양쪽에서 `tool.execute.before` 훅이 발사됨. 두 sessionID가 다른 것은 서브에이전트가 자체 session ID를 가지기 때문이다. 보안 크리티컬 우려 해소.

### 번복 2: HTTP API 권한 중재 경로 미조사 → 완벽 지원 확인 [E2 결과]

리서처 조사는 플러그인 in-process 경로에 집중했고, `opencode serve`의 외부 권한 중재 API는 조사 범위 밖이었다. [Inference — 리서처 보고에서 이 경로 언급 없음]

실험 E2는 다음을 확인했다 [P]:
- `GET /event` SSE 스트림에서 `permission.asked`, `permission.replied` 이벤트가 실시간으로 방출됨
- `POST /permission/:id/reply` 엔드포인트가 실제로 작동함 (CLI의 auto-reject 경로가 이를 사용)
- OpenAPI 3.1.1 스키마에 10개 권한 관련 타입 공식 정의됨

이 발견으로 "비대칭 가설"은 **대칭**으로 번복되었다. OpenCode도 외부 supervisor가 HTTP/SSE를 통해 런타임 권한 중재를 할 수 있다.

### 번복 3: #16367 무한 hang → `opencode run`에서 auto-reject로 회피 [E2 결과]

리서처는 `ask` 정책 + headless 모드에서 무한 hang이 발생한다고 보고했다 [S].
실험 E2에서 `opencode run`은 `permission.ask` 상황에서 **"auto-rejecting" 메시지를 출력하며 exit 0**로 종료했다. [P]

hang 버그(#16367)는 `opencode run`의 자동 거부 핸들러로 회피된 것으로 보인다. 단, 이 핸들러가 언제 도입되었는지, 버그 자체가 수정된 것인지는 별도 확인이 필요하다. [Inference]

---

## 유지되는 발견

### `permission.ask` 훅 미트리거 (#7006) — 플러그인 in-process 경로 한정

실험 E1이 이를 1.3.10에서 재확인했다 [P]:

`hook-trace.log` (E1):
```
[2026-04-10T12:42:39.492Z] plugin.ts loaded
[2026-04-10T12:42:39.493Z] plugin server() called — hooks registering
[2026-04-10T12:42:45.448Z] TOOL_EXECUTE_BEFORE_HOOK_TRIGGERED tool=bash args={...}
```

`tool.execute.before` 는 발사되지만 `permission.ask` 는 발사되지 않는다. 플러그인 in-process 경로에서 대화형 권한 중재는 여전히 불가능하다.

**단, HTTP API 경로는 이 버그에 영향을 받지 않는다.** `permission.ask` 훅 미트리거는 플러그인 in-process 경로의 문제이고, SSE `/event` 스트림 + `POST /permission/:id/reply` 경로는 독립적으로 작동한다. 이는 E1(플러그인 버그 재확인) + E2(HTTP API 정상 작동 확인)의 교차로 성립한다.

---

## 교차 참조

- `experiment-e1-permission-ask.md` — #7006 플러그인 in-process 재현 (1.3.10 현존 확정)
- `experiment-e2-headless-hang.md` — HTTP/SSE 권한 중재 API 발견 (비대칭 가설 번복의 핵심 증거)
- `experiment-e3-subagent-hook.md` — #5894 수정 확정 (보안 크리티컬 우려 해소)
- `research-acp-spec.md` — ACP 모드 권한 중재 경로 상세 (경로 B 후보)

---

*출처 분류: [P] primary(직접 관측) / [S] secondary(문헌·이슈) / [T] tertiary(전달) / [Inference] 추론*
*문서 버전: plan session #1, 2026-04-10*
