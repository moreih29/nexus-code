# experiment-e1-permission-ask.md

**실험 ID**: E1  
**날짜**: 2026-04-10  
**OpenCode 버전**: 1.3.10  
**관련 이슈**: GitHub opencode-ai/opencode #7006  
**판정**: permission.ask 훅 미트리거 — **현존 확정 (플러그인 in-process 경로 한정)**

---

## 배경

GitHub Issue #7006은 OpenCode 플러그인의 `permission.ask` 훅이 권한 요청 시 트리거되지 않는다는 버그 보고다. 이슈는 2025/2026년에 보고된 오래된 항목으로, 1.3.10 릴리즈 시점에 수정 여부가 불명확했다. 이전 리서처(rsch_opencode_permission) 문헌 조사는 "여전히 버그"로 분류했으나 실제 실행 검증은 없었다. E1 실험은 1.3.10에서 재현 여부를 직접 실행으로 확인하고, 동시에 `tool.execute.before` 훅의 baseline 작동 여부도 함께 검증하는 것을 목표로 했다.

---

## 가설

플러그인 `plugin.ts`에 `permission.ask` 훅을 등록하고, bash=ask 권한 설정에서 bash 도구를 실행했을 때 `permission.ask` 훅이 호출되는가?

---

## 실험 설정

### opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin.ts"],
  "permission": {
    "edit": "deny",
    "write": "deny",
    "patch": "deny",
    "multiedit": "deny",
    "bash": "ask"
  }
}
```

bash를 "ask"로, 나머지 파일 편집 도구는 "deny"로 설정해 bash 권한 요청만 발생하도록 격리했다.

### plugin.ts (핵심 부분)

```typescript
const plugin: Plugin = async (_input, _options) => {
  traceLog("plugin server() called — hooks registering");

  return {
    "permission.ask": async (input, output) => {
      const msg = `PERMISSION_ASK_HOOK_TRIGGERED input=${JSON.stringify(input)} output=${JSON.stringify(output)}`;
      traceLog(msg);
    },

    "tool.execute.before": async (input, output) => {
      const msg = `TOOL_EXECUTE_BEFORE_HOOK_TRIGGERED tool=${input.tool} args=${JSON.stringify(output.args)}`;
      traceLog(msg);
    },
  };
};
```

`permission.ask`와 `tool.execute.before` 두 훅을 동시에 등록했다. `tool.execute.before`는 baseline — 플러그인 자체가 정상 로드되고 훅 등록 경로가 올바른지 검증하는 역할이다. 양쪽 모두 `console.error` 출력과 파일 로그(`hook-trace.log`) 기록을 수행한다.

### 실행 환경

- `bun install` — `@opencode-ai/plugin` 최신 설치
- 실행 명령: `opencode run "Use the bash tool to run: echo second-run-test"` (2회 실행)

---

## 실행 절차

```
1회차: opencode run "Use the bash tool to run: echo hello-e1-test"
2회차: opencode run "Use the bash tool to run: echo second-run-test"
```

두 번 실행한 이유: 1회차 로그에 시간 동기화 이슈가 있었고, 2회차에서 hook-trace.log가 clean하게 재초기화되어 최종 증거로 채택했다.

---

## 관찰 결과

### hook-trace.log (전체 — 3줄)

```
[2026-04-10T12:42:39.492Z] plugin.ts loaded
[2026-04-10T12:42:39.493Z] plugin server() called — hooks registering
[2026-04-10T12:42:45.448Z] TOOL_EXECUTE_BEFORE_HOOK_TRIGGERED tool=bash args={"command":"echo second-run-test","description":"Print second-run-test to stdout"}
```

- 플러그인 로드: 정상 (`plugin.ts loaded`)
- 훅 등록: 정상 (`hooks registering`)
- `tool.execute.before`: **fires** — bash 실행 직전 호출됨 (baseline 통과)
- `permission.ask`: **fires 없음** — 파일에 `PERMISSION_ASK_HOOK_TRIGGERED` 문자열 없음

### run-output-2.log (핵심 라인)

```
[2026-04-10T12:42:39.493Z] plugin server() called — hooks registering
> build · glm-5
[2026-04-10T12:42:45.448Z] TOOL_EXECUTE_BEFORE_HOOK_TRIGGERED tool=bash args={"command":"echo second-run-test","description":"Print second-run-test to stdout"}
! permission requested: bash (echo second-run-test); auto-rejecting
✗ bash failed
Error: The user rejected permission to use this specific tool call.
```

`opencode run`은 headless 환경에서 bash=ask 권한 요청이 발생하면 "auto-rejecting" 메시지를 출력하며 스스로 거부 처리한다. 이 동작은 TUI 없는 CLI 실행에 내장된 fallback 처리다.

---

## 판정

**#7006 현존 확정 — 플러그인 in-process `permission.ask` 훅은 OpenCode 1.3.10에서 트리거되지 않는다.**

근거:
1. `tool.execute.before`는 정상 발사 (플러그인 로드·등록 경로 이상 없음)
2. bash=ask 조건에서 실제 권한 요청이 발생함 (`auto-rejecting` 메시지로 확인)
3. 그럼에도 `hook-trace.log`에 `PERMISSION_ASK_HOOK_TRIGGERED` 로그 없음

중요한 제한: 이 판정은 **플러그인 in-process 경로**에 한정된다. E2 실험에서 확인된 HTTP API 경로(`GET /event` SSE 스트림의 `permission.asked` 이벤트 + `POST /permission/:id/reply`)는 이 버그와 독립적으로 정상 작동한다. 두 경로는 별개의 구현이다.

---

## opencode-nexus 함의

플러그인 훅 기반 권한 집행에서 `permission.ask` 훅 사용을 금지한다. 이 훅은 등록해도 호출되지 않으므로 권한 로직의 진입점으로 신뢰할 수 없다.

현재 유효한 플러그인 권한 집행 패턴은 `tool.execute.before` 훅에서 `throw`를 사용해 도구 실행을 직접 차단하는 방식이다. E1 실험에서 `tool.execute.before`는 baseline으로 정상 작동이 확인됐다.

---

## nexus-code 함의

Supervision layer가 OpenCode 세션의 권한 중재를 in-process 플러그인 훅에 의존하는 설계는 채택 불가다. `permission.ask` 훅이 호출되지 않으면 외부 supervisor가 권한 요청을 인식할 수 없다.

대신 두 가지 외부 경로가 유효하다:

- **경로 A (E2 검증)**: `opencode serve` + HTTP/SSE — SSE `/event` 스트림의 `permission.asked` 이벤트 구독 + `POST /permission/:id/reply` 응답. API 레벨에서 완전 지원 확인.
- **경로 B (E4 문헌 조사)**: `opencode acp` + stdio JSON-RPC 2.0 — `session/request_permission` 호출로 권한 중재. 실제 실행 검증은 미완료.

Issue #5 옵션 γ의 OpenCode adapter는 경로 A 또는 경로 B 중 하나를 선택해 AgentHost 인터페이스(`approve`/`reject` 메서드)를 구현한다.

---

## 교차 참조

- `experiment-e2-headless-hang.md` — HTTP API 외부 경로(SSE + REST)가 별도로 정상 작동함을 확인한 실험. E1의 in-process 버그와 독립적.
- `research-opencode-permission.md` (세션 생성 시점의 nexus-temp/experiments/rsch_opencode_permission) — 초기 문헌 조사, #7006을 "여전히 버그"로 예측한 원본 보고서.
- `00-ECOSYSTEM_PRIMER.md §5 결정 #5` — AgentHost 인터페이스 및 OpenCode adapter 전략 결정 배경.
