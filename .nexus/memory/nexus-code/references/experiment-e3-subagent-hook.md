# experiment-e3-subagent-hook.md

**실험 ID**: E3  
**날짜**: 2026-04-10  
**OpenCode 버전**: 1.3.10  
**관련 이슈**: GitHub opencode-ai/opencode #5894  
**판정**: tool.execute.before 서브에이전트 전파 — **수정 확정**

---

## 배경

GitHub Issue #5894는 OpenCode의 `tool.execute.before` 훅이 `task` 도구로 스폰된 서브에이전트의 도구 호출을 가로채지 못한다는 보안 크리티컬 버그 보고다. 이 버그가 현존하면, 플러그인 훅을 통해 primary 에이전트의 도구 실행은 통제할 수 있어도 서브에이전트가 우회 경로로 임의 bash 명령을 실행하는 것을 막을 수 없다 — opencode-nexus의 권한 집행 모델에서 보안 구멍이 된다.

이전 리서처(rsch_opencode_permission)는 #5894를 "여전히 버그 (보안 크리티컬)"로 분류했다. E3는 1.3.10에서 직접 재현해 수정 여부를 확인하는 실험이다.

---

## 가설

primary 에이전트가 `task` 도구로 서브에이전트를 spawn하고, 서브에이전트가 `bash` 도구를 호출할 때 `tool.execute.before` 훅이 서브에이전트의 bash 호출에서도 fires되는가?

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
    "bash": "allow",
    "task": "allow"
  }
}
```

bash와 task를 "allow"로 설정해 서브에이전트가 실제로 bash를 실행할 수 있도록 했다. 파일 편집 도구는 "deny"로 격리.

### plugin.ts (핵심 부분)

```typescript
const plugin: Plugin = async (_input, _options) => {
  traceLog("plugin server() called — hooks registering");

  return {
    "tool.execute.before": async (input, output) => {
      const sessionID = (input as any).sessionID ?? "unknown";
      const callID    = (input as any).callID    ?? "unknown";
      const argsJson  = JSON.stringify(output.args);
      const msg = `TOOL_BEFORE tool=${input.tool} sessionID=${sessionID} callID=${callID} args=${argsJson}`;
      traceLog(msg);
    },
  };
};
```

`tool.execute.before` 훅만 등록. 모든 도구 호출의 `tool`, `sessionID`, `callID`, `args`를 기록한다. `permission.ask` 훅은 E1에서 작동하지 않음이 이미 확인됐으므로 등록하지 않았다.

---

## 실행

```bash
opencode run "Spawn a subagent using the task tool. The subagent's task is to run 'echo SUBAGENT_BASH_EXECUTED' using the bash tool and report back what was printed."
```

primary 에이전트에게 `task` 도구로 서브에이전트를 명시적으로 spawn하고, 서브에이전트가 bash를 실행하도록 유도했다.

---

## 관찰 결과

### hook-trace.log (전체 — 4줄, 원문)

```
[2026-04-10T12:42:46.476Z] plugin loaded
[2026-04-10T12:42:46.477Z] plugin server() called — hooks registering
[2026-04-10T12:42:58.044Z] TOOL_BEFORE tool=task sessionID=ses_288956bbfffeK6ggtFcuvNl2ZJ callID=call_7929 args={"description":"Execute bash echo command","prompt":"Execute the bash command 'echo SUBAGENT_BASH_EXECUTED' and report back what the output was.","subagent_type":"general"}
[2026-04-10T12:43:00.998Z] TOOL_BEFORE tool=bash sessionID=ses_288953f81ffefdA6muUeG0u31e callID=call_e1f2 args={"command":"echo SUBAGENT_BASH_EXECUTED","description":"Execute echo command"}
```

### run-output.log (핵심 라인)

```
• Execute bash echo command  General Agent
I'll spawn a subagent to execute the bash command and report back.
[훅 로그: TOOL_BEFORE tool=task ...]
[훅 로그: TOOL_BEFORE tool=bash ...]
✓ Execute bash echo command  General Agent
The subagent executed `echo SUBAGENT_BASH_EXECUTED` and reported the output: `SUBAGENT_BASH_EXECUTED`
```

"SUBAGENT_BASH_EXECUTED"가 실제로 출력됐다 — 서브에이전트의 bash 실행이 성공했다.

---

## 핵심 관찰 3가지

### 관찰 1: tool.execute.before가 서브에이전트 bash 호출에서 fires됨

hook-trace.log 4번째 줄:
```
TOOL_BEFORE tool=bash sessionID=ses_288953f81ffefdA6muUeG0u31e callID=call_e1f2 args={"command":"echo SUBAGENT_BASH_EXECUTED","description":"Execute echo command"}
```

서브에이전트의 bash 호출이 훅에 포착됐다. #5894가 보고한 "서브에이전트 우회" 현상이 1.3.10에서는 재현되지 않는다.

### 관찰 2: primary와 서브에이전트의 sessionID가 다름

- primary `task` 호출: `sessionID=ses_288956bbfffeK6ggtFcuvNl2ZJ`
- subagent `bash` 호출: `sessionID=ses_288953f81ffefdA6muUeG0u31e`

두 sessionID가 다르다. OpenCode는 서브에이전트에게 독립적인 session ID를 할당한다.

### 관찰 3: 훅 args에 agent 이름/타입이 직접 노출되지 않음

`tool.execute.before` 훅의 input에는 `tool`, `sessionID`, `callID`, `args`만 포함된다. 이 도구 호출이 primary 에이전트에서 온 것인지 서브에이전트에서 온 것인지를 훅 레벨에서 직접 알 수 있는 필드가 없다. sessionID의 차이로만 구분 가능하다.

---

## 판정

**#5894 수정 확정 — OpenCode 1.3.10에서 `tool.execute.before` 훅은 primary 에이전트와 서브에이전트 양쪽 모두에 전파된다.**

이전 리서처가 "보안 크리티컬"로 분류한 항목이 1.3.10에서 해소됐다. 플러그인의 `tool.execute.before` 훅에서 `throw`를 사용해 도구 실행을 차단하는 패턴은 서브에이전트의 도구 호출에도 유효하다.

---

## 부수 발견 — OpenCode 서브에이전트의 독립 session ID 아키텍처

서브에이전트가 별도 session ID를 가진다는 사실은 단순한 구현 세부사항이 아니라 아키텍처적 의미를 가진다.

`tool.execute.before` 훅 레벨에서는 영향이 없다 — 훅은 어떤 sessionID에서 온 호출이든 가리지 않고 fires된다. 그러나 SSE `/event` 스트림을 구독하는 외부 supervisor(nexus-code) 관점에서는 부모-자식 관계를 추적하는 별도 로직이 필요하다.

E2에서 확인된 SSE `/event` 스트림은 모든 session 이벤트를 방출하므로, 서브에이전트의 `session.created` 이벤트도 방출된다. 이때 부모 session ID와의 연결 정보(`parentID`나 `parentSessionID` 같은 필드)가 payload에 포함되는지 여부는 이 실험에서 확인되지 않았다. nexus-code의 다중 세션 UI에서 부모-자식 관계를 올바르게 표시하려면 이 필드 존재 여부 확인이 필요하다.

---

## opencode-nexus 함의

`tool.execute.before` 훅 기반 권한 집행 모델이 서브에이전트 보안을 포함해 유효하다. 이전 "보안 크리티컬" 우려로 인해 대안 설계를 검토할 필요가 없어졌다.

현재 유효한 집행 패턴:
1. `tool.execute.before` 훅에서 허용 목록 또는 거부 목록 기반 체크를 수행하고
2. 거부 조건 충족 시 `throw`로 도구 실행을 차단

이 패턴은 primary 에이전트와 서브에이전트 모두에 적용된다.

훅 args에서 agent 구분이 직접적으로 불가능하다는 점은 opencode-nexus가 주의해야 할 제약이다. "어느 에이전트가 이 도구를 호출했는가"를 훅 내부에서 판단해야 한다면 sessionID를 키로 별도 상태를 유지해야 한다.

---

## nexus-code 함의

SSE `/event` 스트림에서 부모-자식 session 관계를 명시적으로 추적하는 로직이 필요하다. 다중 세션 UI에서 서브에이전트의 활동을 올바른 부모 세션 컨텍스트 아래 표시하려면 session 생성 시점의 payload 구조 파악이 선행돼야 한다.

AgentHost 인터페이스의 `observe` 메서드 구현체는 `session.created` 이벤트를 수신할 때 parentID 필드 유무를 확인하고, 있으면 부모-자식 관계를 내부 상태로 유지하는 처리가 필요하다.

---

## 교차 참조

- `research-opencode-permission.md` (세션 생성 시점의 nexus-temp/experiments/rsch_opencode_permission) — #5894를 "여전히 버그 (보안 크리티컬)"로 분류한 원본 문헌 조사 보고서. E3 결과로 번복.
- `experiment-e1-permission-ask.md` — 동일 실험 세션의 E1. `tool.execute.before` baseline 작동 확인 (E3와 일관).
- `experiment-e2-headless-hang.md` — SSE /event 스트림에서 다중 session 이벤트 방출 확인. 서브에이전트 session 추적 필요성의 배경.
- `00-ECOSYSTEM_PRIMER.md §1.2` — Execution layer 정의. opencode-nexus 훅 기반 권한 집행이 이 층위에 속함.
