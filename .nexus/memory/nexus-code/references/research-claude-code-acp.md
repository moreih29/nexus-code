# research-claude-code-acp.md

> **세션**: plan session #1, nexus-temp, 2026-04-10
> **조사 에이전트**: Researcher + Lead 보완 WebFetch 조사
> **조사 트리거**: rsch_acp_spec 완료 후, 옵션 β(ACP 단일 표준) 실현 가능성 평가를 위해 Claude Code의 ACP 호환성 조사 필요
> **교차 참조**: `agent-sdk-constraint.md`(원문 인용), `research-acp-spec.md`, `experiment-e4-acp-mode.md`

---

## 조사 대상

1. Q1: Claude Code의 ACP 지원 형태 — 네이티브 지원 여부
2. Q2: Zed의 Claude Code ACP 어댑터 — 실체와 구현 방식
3. Q3: Claude Code 공식 권한/스트리밍 모델 — 외부 supervisor가 사용 가능한 공식 경로
4. Q4: Anthropic의 ACP 지원 의도 — 향후 계획 여부
5. Q5: Zed 어댑터 재사용 가능성
6. Q6: 권한 중재 번역의 강건성

이 조사의 최종 목적: **옵션 β(ACP 단일 표준으로 Claude Code + OpenCode 통합)의 실현 가능성 판정**.

---

## 조사 경로

| 단계 | 방법 | 대상 |
|------|------|------|
| 1단계 | GitHub 이슈 조회 | Claude Code GitHub Issue #6686 |
| 2단계 | WebFetch | `github.com/zed-industries/claude-code-acp` |
| 2단계 | WebFetch | `github.com/agentclientprotocol/claude-agent-acp` |
| 3단계 | WebFetch (Lead 직접) | `code.claude.com/docs/en/agent-sdk/overview` |
| 3단계 | Claude Code 공식 문서 | `--permission-prompt-tool`, `--output-format` 옵션 |

증거 분류 기호: **[P]** primary (직접 관측), **[S]** secondary (문헌), **[T]** tertiary (전달된 보고), **[Inference]** 추론

---

## Q1: Claude Code의 ACP 지원 형태 — 네이티브 미지원

**결론: Claude Code는 ACP를 네이티브로 지원하지 않는다.**

### 근거 [S]

**GitHub Issue #6686** "Add ACP support to Claude Code"

- 게시일: 2025년경
- 반응: 439개 👍
- **종결 날짜: 2025-08-27**
- **종결 상태: NOT_PLANNED**

Anthropic은 이 이슈를 "계획 없음"으로 종결했다. 공식적인 이유 설명은 없었다.

**의미**: 현재 시점(2026-04-10) 기준으로 Claude Code CLI 자체에 ACP 프로토콜 처리 코드는 없다. 외부 어댑터 없이 ACP 클라이언트와 직접 통신할 수 없다.

---

## Q2: Zed의 Claude Code ACP 어댑터 — 두 레포지토리

### 어댑터 A: `zed-industries/claude-code-acp` [S]

- 위치: GitHub `zed-industries/claude-code-acp`
- Lead의 WebFetch 결과: 현재 main 브랜치는 `@anthropic-ai/claude-agent-sdk`를 **production dependency**로 사용
- bin 이름: `claude-agent-acp`

이 어댑터는 CLI 래퍼로 추정되었으나, 실제로는 **Claude Agent SDK 기반으로 재구성**되어 있다.

### 어댑터 B: `agentclientprotocol/claude-agent-acp` [S]

- 위치: GitHub `agentclientprotocol/claude-agent-acp`
- 버전: **v0.26.0**
- 릴리즈 수: **77개**
- Stars: **1,600+**
- 라이선스: Apache 2.0

이 어댑터 역시 `@anthropic-ai/claude-agent-sdk`를 핵심으로 사용하는 SDK 기반 구현이다.

### 핵심 결론 [Inference]

공개된 Claude Code ACP 어댑터는 **모두 Agent SDK 기반으로 재구성**되어 있다. 즉, "Claude Code CLI를 ACP에 연결하는 어댑터"가 아니라, "Agent SDK로 에이전트를 새로 구현하고 그것을 ACP 인터페이스로 노출하는 어댑터"다.

이것은 중요한 구분이다. Agent SDK 기반 어댑터는 Claude Code CLI의 기능(계속된 세션, stream-json 파이프, `--permission-prompt-tool` 등)을 그대로 쓰지 않는다. 새로운 에이전트 런타임을 구성한다.

---

## Q3: Claude Code 공식 권한/스트리밍 모델

Claude Code CLI가 제공하는 외부 supervisor 연동 공식 경로는 세 가지다.

### 경로 1: `--output-format stream-json` [S]

```bash
claude --output-format stream-json "프롬프트"
```

- CLI 출력 포맷 옵션
- AI 응답, 도구 호출 결과 등을 JSON 스트림으로 stdout에 출력
- **권한 요청 이벤트는 이 채널을 통과하지 않는다**
- `--input-format stream-json` 옵션은 존재하나 공식 문서에 없는 **undocumented** 옵션

nexus-code의 기존 ProcessSupervisor + ApprovalBridge는 이 스트림을 파싱하고, 권한 요청 발생 시 stdin으로 응답을 주입하는 방식으로 구현되어 있다.

### 경로 2: `--permission-prompt-tool <mcp-tool>` [S]

```bash
claude --permission-prompt-tool mcp_server__ask_permission "프롬프트"
```

- 공식 문서에 기재된 옵션
- 권한 요청 발생 시, CLI가 지정된 MCP 도구를 호출해 승인/거부를 받는다
- MCP 서버를 별도로 구현해야 하므로 통합 복잡도가 높다

### 경로 3: `@anthropic-ai/claude-agent-sdk`의 `canUseTool` 콜백 [S]

```typescript
const agent = new ClaudeAgent({
  canUseTool: async (tool) => {
    const approved = await askUserPermission(tool);
    return approved;
  }
});
```

- Anthropic 공식 경로
- 성숙도 있음 (여러 릴리즈, 공식 문서)
- **단, API key 전용 — 구독제 호환 불가** (Q4, Q5에서 상세 설명)

---

## Q4: Anthropic의 ACP 지원 의도

**결론: Anthropic은 Claude Code에 ACP 지원을 추가할 의도가 없다.**

GitHub Issue #6686 NOT_PLANNED 종결로 확인. [S]

Anthropic이 공식적으로 선택한 방향은 ACP가 아니라 **`@anthropic-ai/claude-agent-sdk`** (구 claude-code-sdk에서 리네임)다. 이 SDK가 Anthropic 공식 에이전트 통합 경로다.

---

## 결정적 발견: Agent SDK 공식 문서의 구독제 금지 조항

### 원문 인용 [P — Lead 직접 WebFetch, `code.claude.com/docs/en/agent-sdk/overview`]

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."

### 번역 및 해석

"사전 승인 없이, Anthropic은 제3자 개발자가 자사 제품에서 claude.ai 로그인이나 rate limits를 제공하는 것을 허용하지 않는다. Claude Agent SDK 기반으로 구축된 에이전트 포함. 이 문서에 기술된 API key 인증 방식을 사용할 것."

### 의미 [Inference]

이 조항이 적용되는 범위: **"agents built on the Claude Agent SDK"** — 즉, Agent SDK를 사용하는 모든 서드파티 에이전트.

nexus-code는 서드파티 개발자가 만드는 도구다. 따라서 nexus-code가 Agent SDK를 사용해 에이전트를 구성할 경우, **Claude Pro/Max 구독제 사용자의 claude.ai 계정으로 인증하는 것이 명시적으로 금지**된다.

이것은 규칙 해석의 여지가 없는 명시적 금지 조항이다. "사전 승인"을 받으면 예외가 가능하지만, 일반적인 서드파티 도구 개발에서 사전 승인을 받는 경로는 없다.

---

## Q5: Zed 어댑터 재사용성 — 제한적

Zed의 두 어댑터(`zed-industries/claude-code-acp`, `agentclientprotocol/claude-agent-acp`) 모두 Agent SDK 기반이다. [S]

이들을 nexus-code에서 재사용할 경우:
- Agent SDK 의존성이 도입된다
- 따라서 구독제 사용자 지원이 불가능해진다
- 어댑터를 재사용하면 §4.2 제약 위반이 발생한다

**재사용 불가 판정**. [Inference]

---

## Q6: 권한 중재 번역 강건성 — 부분 번역 의심

설령 구독제 제약이 없더라도, Zed 어댑터를 통한 권한 중재 번역이 완전히 강건하지 않을 가능성이 있다. [Inference]

근거:
- Zed 어댑터는 Zed 에디터 UI를 전제로 설계됨
- nexus-code의 권한 중재 흐름(ApprovalBridge + UI 표시)과 1:1 대응이 보장되지 않음
- 번역 누락 또는 의미 변형 가능성에 대한 실제 검증이 이루어진 바 없음

이 항목은 확신 수준이 낮다. 실제 검증 없이는 단정할 수 없다. [Inference]

---

## 옵션 β(ACP 단일 표준) 실현 가능성 최종 판정

**판정: 낮음~중간**

| 장애 요소 | 심각도 | 해소 가능성 |
|----------|--------|-------------|
| Anthropic NOT_PLANNED (#6686) | 높음 | 낮음 (외부에서 변경 불가) |
| Agent SDK 구독제 금지 조항 | 높음 (§4.2 제약) | 없음 (Anthropic 정책) |
| claude-code-acp가 Agent SDK 기반 재구성 | 높음 | 낮음 (어댑터 교체 필요) |
| 권한 번역 미검증 | 중간 | 검증으로 해소 가능 |
| Question tool hang (#17920) | 중간 | PR #13750 머지 후 해소 |

**구독제 호환 불가가 결정적 장애**다. nexus-code의 핵심 페르소나(민지 = Claude Pro/Max 구독제 사용자)가 ACP 단일 표준 경로를 사용할 수 없다. dogfooding 및 PMF 불가. [§4.1, §4.2 제약]

---

## 옵션 γ 추천 근거

### 왜 옵션 γ인가 [Inference]

**Anthropic 공식 경로(Agent SDK)는 존재하나 구독제 사용자에게 닫혀 있다.**

이 사실로부터 도출되는 유일한 현실적 설계 방향:

1. Claude Code를 직접 CLI spawn + stream-json + ApprovalBridge로 제어 → 구독제 사용자가 로컬에서 `claude` CLI를 실행하므로 API key 불필요
2. OpenCode를 `opencode serve` HTTP/SSE 또는 `opencode acp` stdio로 제어 → 구독제 사용자가 로컬에서 `opencode` 를 실행하므로 API key 불필요
3. nexus-code는 두 하네스를 통합 관리하는 AgentHost 인터페이스를 정의하고, 하네스별 어댑터를 구현

이것이 옵션 γ다.

### nexus-code의 ProcessSupervisor는 우회로가 아니라 필연 [Inference]

두 가지 독립된 사실이 같은 결론을 가리킨다:

**사실 1**: Claude Code CLI의 권한 구조는 비대화형이다. `--output-format stream-json`에서 권한 요청 이벤트가 통과하지 않는다. 외부 supervisor(ApprovalBridge)가 없으면 권한 중재를 외부에서 처리할 수 없다.

**사실 2**: Agent SDK는 API key 전용이고, 구독제 사용자에 대한 사용이 명시적으로 금지되어 있다.

따라서 nexus-code의 ProcessSupervisor + ApprovalBridge 패턴은:
- Claude Code의 기술적 한계를 극복하는 필요한 설계이며
- Anthropic 정책 제약 하에서 구독제 사용자를 지원하는 **유일한 경로**다

이것은 우회로(workaround)가 아니라, 제약 조건들이 수렴하는 **필연적 설계**다.

---

## 교차 참조

- `agent-sdk-constraint.md` — Agent SDK 공식 문서 구독제 금지 조항 원문 보존
- `research-acp-spec.md` — ACP 프로토콜 명세 (OpenCode ACP 경로 B 상세)
- `experiment-e4-acp-mode.md` — ACP 실험 초기 실패 경위

---

*출처 분류: [P] primary(직접 관측) / [S] secondary(문헌) / [T] tertiary(전달) / [Inference] 추론*
*문서 버전: plan session #1, 2026-04-10*
