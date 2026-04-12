# 05-REFERENCES.md — nexus-code references 인덱스

> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10.
> 이 문서는 `references/` 서브폴더에 있는 9개 파일 전체를 인덱싱한다. 각 파일의 핵심 메시지, nexus-code 관점에서의 중요도, 그리고 plan session #1 결정과의 연관성을 정리한다.

---

## 읽기 우선순위 안내

옵션 γ(AgentHost 인터페이스) 채택 근거를 빠르게 확인하려면: **E2 → research-claude-code-acp → agent-sdk-constraint** 순서로 읽는다.

OpenCode adapter 경로 선택(`04-OPEN_QUESTIONS.md` Q1)을 준비하려면: **E2 → E4 → research-acp-spec → research-opencode-permission** 순서로 읽는다.

Claude Code Permission 메커니즘 전체 이해를 원하면: **E1 → E3 → bridge-quotes** 순서로 읽는다.

---

## 파일별 상세

### 1. `references/bridge-quotes.md`

**핵심 메시지**: nexus-code와 Claude Code CLI 사이의 감독 계약, ApprovalBridge 설계 원칙, ProcessSupervisor 역할에 관한 인용 모음.

**nexus-code 관점에서 중요한 이유**: ClaudeCodeHost adapter를 작성할 때(`03-IMPLEMENTATION_GUIDE.md` §9) ApprovalBridge의 계약과 경계를 확인하는 기준 문서다. "우회로가 아닌 필연"이라는 판단의 배경이 이 인용들에서 도출된다.

**plan session #1 연관**: Issue #5 옵션 γ 채택 근거 중 "ProcessSupervisor는 핵심 자산" 판단의 직접적 근거.

---

### 2. `references/agent-sdk-constraint.md`

**핵심 메시지**: Anthropic 공식 문서의 Agent SDK 사용 제한 조항 원문 인용 및 분석. "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

**nexus-code 관점에서 중요한 이유**: 이 문서 하나가 옵션 β, δ, ε 전부를 폐기하는 근거를 제공한다. 민지 페르소나(Claude Pro/Max 구독제)가 Agent SDK 기반 경로를 사용할 수 없음을 공식 문서 레벨에서 확인한다. **이 파일은 설계 방향 논쟁 시 가장 먼저 제시해야 하는 근거다.**

**plan session #1 연관**: Issue #5에서 옵션 β/δ/ε 폐기의 결정적 근거. Primer §4.2의 원천 자료.

---

### 3. `references/experiment-e1-permission-ask.md`

**핵심 메시지**: E1 실험 — Claude Code #7006 이슈 재현. Claude Code CLI에서 권한 요청이 발생하는 정확한 조건과 Pre-tool-use hook이 개입하는 타이밍 확인.

**nexus-code 관점에서 중요한 이유**: ApprovalBridge의 기반이 되는 Pre-tool-use hook 동작을 검증한 실험이다. `permission_asked` 이벤트가 AgentHostEvent 타입에 포함되어야 하는 이유, 그리고 `approve() / reject()` 메서드가 필요한 이유의 경험적 근거.

**plan session #1 연관**: Issue #5 AgentHost 인터페이스 설계에서 `permission_asked` 이벤트 타입과 `approve() / reject()` 메서드 결정의 배경.

---

### 4. `references/experiment-e2-headless-hang.md`

**핵심 메시지**: E2 실험 — OpenCode headless 모드에서 발생한 hang 현상 조사 중 **SSE permission API의 존재와 동작을 결정적으로 확인**. `GET /event` SSE 엔드포인트와 `POST /permission/:id/reply` 엔드포인트의 실제 동작이 검증됨.

**nexus-code 관점에서 중요한 이유**: OpenCode adapter 경로 A(`opencode serve` + HTTP/SSE)의 핵심 증거다. 이 실험이 없었다면 OpenCode에서 외부 감독자가 permission 결정에 개입할 수 있는지 알 수 없었다. **옵션 γ 채택의 가장 결정적인 현장 증거.**

**plan session #1 연관**: Issue #5에서 OpenCode adapter 경로 A가 실현 가능함을 확인한 직접 증거. `04-OPEN_QUESTIONS.md` Q1에서 경로 A가 유력 후보인 이유.

---

### 5. `references/experiment-e3-subagent-hook.md`

**핵심 메시지**: E3 실험 — Claude Code #5894 이슈(서브에이전트 hook 미작동) 수정 확인. Claude Code CLI에서 서브에이전트가 실행하는 도구에도 Pre-tool-use hook이 정상적으로 작동함을 검증.

**nexus-code 관점에서 중요한 이유**: nexus-code가 멀티-에이전트 세션(Lead가 서브에이전트를 spawn하는 경우)을 감독할 때 ApprovalBridge가 모든 레벨의 도구 실행을 가로챌 수 있음을 확인. ProcessSupervisor 모델의 신뢰성 근거.

**plan session #1 연관**: Issue #5 ClaudeCodeHost adapter의 신뢰성 전제 중 하나.

---

### 6. `references/experiment-e4-acp-mode.md`

**핵심 메시지**: E4 실험 — `opencode acp` 명령(stdio JSON-RPC 2.0 방식) 검증 시도. **미완료**. ACP stdio 경로의 실제 동작, 특히 permission 요청 처리 부분을 검증하지 못함.

**nexus-code 관점에서 중요한 이유**: OpenCode adapter 경로 B(`opencode acp` + stdio)의 현재 상태가 미검증임을 나타낸다. 이 파일이 미완료 상태이기 때문에 경로 B는 `04-OPEN_QUESTIONS.md` Q1에서 "추가 검증 필요" 상태로 남는다.

**plan session #1 연관**: Issue #5에서 경로 A/B 선택을 `04-OPEN_QUESTIONS.md`로 미룬 직접적 이유. `researcher` 에이전트를 통해 E4 보완 조사가 필요함을 시사.

---

### 7. `references/research-opencode-permission.md`

**핵심 메시지**: OpenCode의 permission 시스템에 대한 초기 조사 문서. 이후 E2 실험을 통해 일부 내용이 번복되거나 구체화됨.

**nexus-code 관점에서 중요한 이유**: OpenCode adapter 설계 초기에 참고한 배경 정보. 그러나 E2 실험 이후 SSE API 동작에 관한 부분은 E2 결과를 우선한다. 이 문서의 내용이 E2와 충돌하면 E2를 따른다.

**plan session #1 연관**: Issue #5 OpenCode adapter 논의의 초기 배경 자료. 신뢰도는 E2 다음.

---

### 8. `references/research-acp-spec.md`

**핵심 메시지**: ACP(Agent Client Protocol, Zed 주도 오픈 표준)의 상세 스펙. stdio JSON-RPC 2.0 transport, 메서드 목록, `session/request_permission` 등 권한 관련 메서드 포함.

**nexus-code 관점에서 중요한 이유**: OpenCode adapter 경로 B의 이론적 기반. ACP가 오픈 표준이라는 점에서 장기적 interoperability 측면에서 매력적이다. 단, Claude Code ACP 어댑터가 Agent SDK 기반임(→ 구독제 불가)이 명확해진 상황에서, ACP는 "OpenCode 감독 전용 경로"로만 고려된다.

**plan session #1 연관**: Issue #5에서 ACP가 통합 표준이 될 수 없는 이유(→ Claude Code 쪽이 Agent SDK 기반이라 구독제 불가)가 `research-claude-code-acp.md`와 함께 확인됨.

---

### 9. `references/research-claude-code-acp.md`

**핵심 메시지**: Claude Code의 ACP 어댑터 호환성 조사. **Claude Code ACP 어댑터가 Agent SDK 기반으로 재구성되어 있음을 발견.** 이 발견이 ACP 단일 통합 경로를 폐기하는 결정적 근거.

**nexus-code 관점에서 중요한 이유**: E2와 함께 옵션 γ 채택을 가장 강하게 지지하는 증거다. "ACP 하나로 Claude Code와 OpenCode를 통합 감독한다"는 옵션 β가 왜 불가능한지를 공식 경로 분석 레벨에서 설명한다. Primer §4.4의 원천 자료.

**plan session #1 연관**: Issue #5 옵션 β 폐기의 직접 근거. E2와 함께 이 두 파일이 옵션 γ 선택의 가장 결정적인 증거 쌍이다.

---

## 참조 관계 요약

```
옵션 γ 채택 근거
  ├── agent-sdk-constraint.md → 옵션 β/δ/ε 폐기 (Agent SDK = API key 전용)
  ├── research-claude-code-acp.md → 옵션 β 폐기 (Claude Code ACP = Agent SDK 기반)
  └── experiment-e2-headless-hang.md → OpenCode HTTP/SSE 경로 실현 가능 확인

ProcessSupervisor 보존 근거
  ├── bridge-quotes.md → 구조적 필연성
  ├── agent-sdk-constraint.md → 구독제 유일 경로
  └── experiment-e1-permission-ask.md + experiment-e3-subagent-hook.md → 동작 검증

OpenCode adapter 경로 선택 (미결, 04-OPEN_QUESTIONS.md Q1)
  ├── 경로 A 근거: experiment-e2-headless-hang.md
  ├── 경로 B 근거: research-acp-spec.md
  ├── 경로 B 미검증: experiment-e4-acp-mode.md (미완료)
  └── 초기 배경: research-opencode-permission.md
```

---

*이 문서는 plan session #1 (2026-04-10) 기준 references 인덱스다. 각 실험 파일의 최신 결과는 해당 파일을 직접 참조할 것.*
