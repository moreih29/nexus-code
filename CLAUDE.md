<!-- PROJECT:START -->
# Nexus Code

Claude Code CLI를 로컬 데스크톱 GUI로 오케스트레이션하는 워크스테이션.
워크스페이스 관리, 실시간 세션 스트리밍, 권한 제어로 CLI를 안전하게 다룬다.

## Essentials

- **패키지 매니저**: Bun 전용 (`bun install`, `dev`, `build`, `typecheck`, `test:e2e`). npm/yarn 금지
- **Monorepo**: `packages/{shared,server,web,electron}` — 빌드 순서 `shared → server/web → electron`
- **3계층 통신**: web ↔ server는 HTTP/SSE, CLI → server는 Pre-tool-use hook (권한 제어)
- **타입 계약**: `@nexus/shared`의 Zod 스키마가 유일한 SoT (Workspace/Session/Approval/Event)
- **코드 스타일**: TypeScript strict, kebab-case 파일명, 한글 UI, 다크 테마 고정
- **권한 제어**: 훅/승인 정책 수정 시 재주입·SSE push·tool_result 파싱 모두 검증
- **테스트**: Vitest (unit), Playwright (`bun run test:e2e`, 빌드 선행 필요)
<!-- PROJECT:END -->

<!-- NEXUS:START -->
## Nexus Agent Orchestration

**Default: DELEGATE** — route code work, analysis, and multi-file changes to agents.

Lead는 사용자와 직접 대화하는 메인 에이전트. tasks.json에서 `owner: "lead"`는 Lead가 직접 처리.

Before starting work, check `.nexus/memory/` and `.nexus/context/` for project-specific knowledge.

### .nexus/ Structure

- `memory/` — lessons learned, references (`[m]`)
- `context/` — design principles, architecture philosophy (`[sync]`)
- `rules/` — project custom rules (`[rule]`)
- `state/` — plan.json, tasks.json (runtime)

### Agent Routing

병렬 작업이나 다른 관점이 필요할 때 에이전트를 활용하라.

| 이름 | Category | Task | Agent |
|------|----------|------|-------|
| 아키텍트 | HOW | Architecture, technical design, code review | architect |
| 디자이너 | HOW | UI/UX design, interaction patterns, user experience | designer |
| 포닥 | HOW | Research methodology, evidence synthesis | postdoc |
| 전략가 | HOW | Business strategy, market analysis, competitive positioning | strategist |
| 엔지니어 | DO | Code implementation, edits, debugging | engineer |
| 리서처 | DO | Web search, independent investigation | researcher |
| 라이터 | DO | Technical writing, documentation, presentations | writer |
| 리뷰어 | CHECK | Content verification, fact-checking, grammar review | reviewer |
| 테스터 | CHECK | Testing, verification, security review | tester |

단순 작업(파일 1-2개 읽기/수정)은 직접 처리하라.

### Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| nx-init | /claude-nexus:nx-init | Full project onboarding: scan codebase, establish project mission and essentials, generate context knowledge |
| nx-plan | [plan] | Structured planning — subagent-based analysis, deliberate decisions, produce execution plan |
| nx-run | [run] | Execution — user-directed agent composition |
| nx-setup | /claude-nexus:nx-setup | Configure Nexus interactively |
| nx-sync | [sync] | Synchronize .nexus/context/ design documents with current project state |

### Tags

| Tag | Purpose |
|-----|---------|
| [plan] | 계획 — 리서치, 다관점 분석, 결정, 계획서 생성 |
| [d] | 결정 기록 (plan 세션 내 nx_plan_decide 호출) |
| [run] | 실행 — 계획서 기반 서브에이전트 병렬 실행 |
| [rule] | 규칙 저장 — [rule:태그] 형식 지원 |
| [m] | 메모 저장 — 교훈, 참조를 .nexus/memory/에 압축 저장 |
| [m:gc] | 메모 정리 — .nexus/memory/ 파일 병합/삭제 |
| [sync] | 컨텍스트 동기화 — .nexus/context/ 설계 문서 업데이트 |
<!-- NEXUS:END -->
