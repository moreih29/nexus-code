# nexus-code (Archived)

> 이 레포지터리는 **2026-04-14 개발 중단 + 아카이브 처리**됐습니다.
> 새 작업은 받지 않으며 이슈/PR 대응도 하지 않습니다. 과거 시도와 학습 기록으로만 보관됩니다.

## 원래 하려던 것

Claude Code (Anthropic) / OpenCode (Anomaly Co.) 같은 AI 코딩 에이전트 CLI 세션을 외부에서 spawn · 관찰하고, 권한 요청을 Policy Enforcement Point(PEP)로 중재하는 **통합 워크벤치**. Tauri + Bun + TypeScript + React 스택, Claude Pro/Max 구독 기반 사용을 핵심 가치로 설정.

## 폐기 사유

1. **Anthropic 폐쇄 정책** — 2026-02 정책 변경으로 `@anthropic-ai/claude-agent-sdk`에서 Pro/Max OAuth 사용 금지. 외부 래퍼는 API 키 기반만 허용. "구독으로 쓰는 워크벤치"라는 핵심 가치가 사라짐.
2. **CLI `stream-json` 다중 턴 비공식** — `--input-format stream-json`으로 두 번째 메시지 처리 시 hang / session 미저장 이슈가 Anthropic 공식 레포에 4회 이상 독립 보고됨 (#3187, #25629, #39700, #41230). 모두 미해결 또는 자동 종료. 공식 문서화되지 않은 경로 위에 쌓는 모든 것이 구조적으로 불안정.
3. **대체재 이미 존재** — OpenCode 방향으로 pivot 검토했으나 공식 Tauri 데스크톱 앱 + Palot / opencode-gui / opencode-pilot 등 서드파티 GUI가 이미 성숙. 우리가 새로 만들 명분 확보 실패.

## 남아 있는 학습 가치

- `packages/tauri/`: Tauri v2 + Bun `--compile` single-file 사이드카 패턴 (Phase 1-2 Cycle A/B/C)
- `packages/server/`: Hono + Bun + `bun:sqlite` 기반 localhost 서버, SSE `streamSSE` 사용 사례와 idle disconnect 회피 heartbeat
- `packages/web/`: React 18 + Zustand + React Query + EventSource 통합 패턴
- `@nexus/shared`: Zod 스키마 단일 SoT로 web ↔ server 타입 계약 관리
- `.nexus/`: plan / run / memory / context 기반 LLM 오케스트레이션 흔적

## 기술 교훈

- **SSE race 버그는 transport 문제가 아니라 lifecycle 설계 문제** — long-lived process + stdin write는 stream-json CLI의 비공식 경로. 표준은 per-turn spawn + `--resume <sessionId>` + `stdin.end()`.
- **LLM 개발은 신규 작성엔 강하지만 런타임 race 디버깅엔 약함** — 플랫폼 quirk (WKWebView, Bun 스트림 flush)은 실측 반복이 필수.
- **외부 CLI 래퍼 프로젝트의 구조적 취약성** — 벤더 정책 변경 한 번에 모든 가치 제안이 무너질 수 있음.

## 대안 프로젝트

같은 문제 공간을 탐색 중이라면 우리가 아니라 아래를 권장:

- [OpenCode 공식 Tauri 데스크톱 앱](https://opencode.ai/) — provider-agnostic, MIT 라이선스
- [ItsWendell/palot](https://github.com/ItsWendell/palot) — Electron multi-agent GUI
- [jazarie2/opencode-gui](https://github.com/jazarie2/opencode-gui) — REST API 기반 GUI
- [anomalyco/opencode](https://github.com/anomalyco/opencode) — OpenCode 본체

## 마지막 상태

- `main`: 폐기 이전 마지막 안정 스냅샷 (본 커밋 직전까지 Phase 2 Cycle C + 로깅 통합)
- `fix/workspace-ui-reset`: 두 번째 메시지 SSE 미수신 버그 진단 시도 (미해결, 로컬 전용 브랜치)
- `feat/tauri-phase2-cycle-{a,b,c}`: Tauri 마이그레이션 단계별 스냅샷 (로컬 전용)
- `.nexus/memory/workspace-ui-fix-backlog.md`: 폐기 시점 미해결 버그 마지막 진단 로그

## 라이선스

별도 명시 없음 (private / 개인 학습 목적).
