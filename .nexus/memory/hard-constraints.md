# Hard Constraints — 재탐색 방지용 기술 제약

> plan session #1 (2026-04-10) 결정. 이 제약들을 위반하는 설계 방향은 이미 검토·폐기됨.

## 1. Agent SDK 경로 금지

Anthropic 공식 문서: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

`@anthropic-ai/claude-agent-sdk`는 API key 전용. 민지(Claude Pro/Max 구독제 사용자)를 지원할 수 없음. 이 경로를 전제로 한 모든 설계는 폐기 대상.

## 2. ACP 단일 통합 불가

Claude Code의 ACP 어댑터가 Agent SDK 기반으로 재구성됨 → ACP 하나로 Claude Code + OpenCode 통합 감독 불가.
ACP는 OpenCode 전용 경로로만 유효.

## 3. ProcessSupervisor + stream-json은 유일 경로

Claude Code CLI spawn + stream-json 파싱 + ApprovalBridge = 구독제 사용자가 Claude Code 세션을 외부 감독할 수 있는 유일한 방법. 우회로가 아니라 구조적 필연. 제거 금지, AgentHost 뒤에 래핑만 허용.

## 4. nexus-core 쓰기 금지

read-only consumer만 허용. 빌드 타임 metadata 소비만. runtime 코드 기여, fork, runtime import 전부 금지.

## 5. 실험 근거 요약

| 실험 | 결론 |
|------|------|
| E1 (permission-ask) | Claude Code Pre-tool-use hook이 권한 요청 시점에 정상 개입. ApprovalBridge 기반 확인. |
| E2 (headless-hang) | OpenCode `opencode serve`의 SSE permission API 동작 확인. `GET /event` + `POST /permission/:id/reply` 실동작. |
| E3 (subagent-hook) | 서브에이전트가 실행하는 도구에도 Pre-tool-use hook 정상 작동. 멀티에이전트 감독 가능. |
| E4 (acp-mode) | `opencode acp` stdio JSON-RPC 경로 — **미완료**. permission 처리 미검증. |
| research-claude-code-acp | Claude Code ACP 어댑터 = Agent SDK 기반. 구독제 불가 확인. |
| research-nexus-core-structure | nexus-core는 `manifest.json`으로 통합 export. `require.resolve`로 접근. |
