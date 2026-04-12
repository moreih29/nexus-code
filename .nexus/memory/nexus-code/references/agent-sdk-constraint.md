# agent-sdk-constraint.md — Anthropic Agent SDK 공식 문서 인용 보존

## 출처

`https://code.claude.com/docs/en/agent-sdk/overview` (Anthropic 공식 문서)
확인 날짜: 2026-04-10 (plan session #1, nexus-temp)

## 이 파일의 목적

세션에서 nexus-code의 옵션 β/δ/ε 폐기의 결정적 근거가 된 Anthropic Agent SDK 공식 문서 인용을 보존한다. 이 인용들이 세션 Issue #5 결정과 §4 제약 조건들을 정당화한 일차 증거다.

교차 참조: [bridge-quotes.md](./bridge-quotes.md), research-claude-code-acp.md

---

## 인용 1: "Set your API key" 섹션

원문 인용:

> Get an API key from the Console, then set it as an environment variable: `export ANTHROPIC_API_KEY=your-api-key`

세션(plan #1)에서의 해석: Agent SDK의 기본 인증 메커니즘은 API key다. 이 사실이 뒤에 나오는 핵심 Note(인용 3)의 전제를 설정한다.

---

## 인용 2: "third-party API providers"

원문 인용 (해당 섹션 열거):

> Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`), Microsoft Azure Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`)

세션(plan #1)에서의 해석: 열거된 대안들이 모두 별도 유료 API 제공자다. 이들도 API key 기반 인증을 사용하며, Claude Pro/Max 구독제와 관계가 없다. "다른 API provider를 쓰면 구독제를 우회할 수 있다"는 추론이 성립하지 않는다.

---

## 인용 3: 핵심 Note — 결정적 제약

원문 인용 (전문):

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead.

세션(plan #1)에서의 해석:

이 Note가 nexus-code 설계에 적용되는 방식:

1. "third party developers" — nexus-code의 개발자는 Anthropic이 아니므로 제3자 개발자에 해당한다.
2. "offer claude.ai login or rate limits" — Claude Pro/Max 구독제 사용자가 자신의 계정으로 로그인하여 rate limit을 사용하는 시나리오가 여기에 해당한다.
3. "including agents built on the Claude Agent SDK" — `@anthropic-ai/claude-agent-sdk`(현 `@anthropic-ai/claude-agent-sdk`, 리네임 후 Claude Agent SDK) 기반으로 구축된 제품에 **명시적으로** 이 금지가 적용된다.
4. "Unless previously approved" — 사전 승인 예외가 있으나, nexus-code는 해당 승인을 받지 않은 일반 개발 경로다.

결론: Agent SDK 기반으로 nexus-code를 설계하면, 민지(=본인=Claude Pro/Max 구독제 사용자)가 자신의 구독을 통해 이 제품을 사용할 수 없다. Agent SDK 기반 설계는 페르소나와 직접 충돌하여 민지가 쓸 수 없는 제품이 된다.

---

## SDK 리네임 사실

원문 인용:

> The Claude Code SDK has been renamed to the Claude Agent SDK.

세션(plan #1)에서의 해석: Anthropic의 공식 에이전트 개발 경로가 SDK임을 확인한다. 동시에 ACP(Agent Client Protocol)는 Zed 주도의 독립 오픈 표준으로 Anthropic의 네이티브 경로가 아님을 암시한다. ACP를 "Anthropic 공식 경로"로 오해하여 Claude Code 통합의 대안으로 채택하려는 시도가 기각되는 배경.

---

## 브랜딩 가이드라인 (참고용)

원문 인용:

> Not permitted: 'Claude Code' or 'Claude Code Agent'

세션(plan #1)에서의 재해석: 이 브랜딩 가이드라인이 "nexus-code" 이름에 적용되는지를 Issue #4에서 검토하였다. 사용자 판단 — Anthropic 트레이드마크의 핵심은 "Claude"이지 "code"가 아니다. "code"는 vscode, opencode, claude code 등에서 범용 명사로 사용된다. 따라서 "nexus-code"는 "Claude Code"나 "Claude Code Agent"에 해당하지 않으며 브랜딩 가이드라인 위반이 아니다. 이 해석 아래 nexus-code 이름을 유지하기로 결정(Issue #4 확정).

---

## 이 인용이 정당화한 세션 결정들

인용 3(핵심 Note)이 직접 근거가 된 결정:

1. **Issue #5 옵션 β 폐기** — ACP 단일 표준 채택 옵션: Claude Code의 ACP 어댑터가 Agent SDK 기반으로 재구성되어 구독제 호환 불가. 이 Note가 그 경로를 차단한다.
2. **Issue #5 옵션 δ 폐기** — (Agent SDK 직접 사용 방향 옵션): Agent SDK 기반은 구독제 사용 불가로 명시적 폐기.
3. **Issue #5 옵션 ε 폐기** — (Bedrock/Vertex/Azure 우회 방향 옵션): 인용 2에서 확인한 바와 같이 이들도 별도 유료 API provider이며 구독제와 무관.
4. **Issue #5 옵션 γ 확정** — AgentHost 추상화 인터페이스 + 하네스별 구현체: Claude Code 어댑터는 기존 ProcessSupervisor + stream-json + ApprovalBridge 유지. 구독제 사용자가 Claude Code 세션을 외부에서 감독할 수 있는 유일한 경로를 보존.
5. **Issue #2 ACP vocabulary nexus-core 편입 거부** — ACP는 "구독제 생태계 밖" 판단. Agent SDK 기반 ACP 어댑터가 구독제 호환 불가이므로 ACP vocabulary를 nexus-core에 포함하는 것은 시기상조.
6. **Issue #4 nexus-code 이름 유지** — 브랜딩 가이드라인 재해석 결과 "nexus-code"는 허용 범위 내.

Primer §4.2의 직접 출처:

> `@anthropic-ai/claude-agent-sdk`는 API key 전용이다. Anthropic 공식 문서는 "claude.ai login이나 rate limits를 제3자 제품에서 사용하는 것을 허용하지 않는다"고 명시한다. Agent SDK 기반 설계는 구독제 사용자를 지원할 수 없으므로, 이 경로를 전제로 한 설계 방향은 채택될 수 없다.

이 Primer 문구는 위 인용 3의 직접 요약이다.

---

*이 파일: plan session #1, nexus-temp, 2026-04-10. Anthropic 공식 문서 변경 시 인용 및 해석을 재검토할 것.*
