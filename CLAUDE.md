# Nexus Code

Claude Code CLI를 GUI로 래핑하는 Electron 데스크톱 앱.

## Commands

```bash
bun install          # 의존성 설치
bun run dev          # 개발 서버 (HMR)
bun run build        # 프로덕션 빌드
bun run typecheck    # 타입 체크
bun run test:e2e     # E2E 테스트 (빌드 선행 필요)
```

## Code Style

- TypeScript strict mode, kebab-case 파일명
- React 함수 컴포넌트, Zustand 상태 관리
- Tailwind CSS v4 다크 테마, 한글 UI 텍스트

<!-- NEXUS:START -->
## Nexus Agent Orchestration

**Default: DELEGATE** — route code work, analysis, and multi-file changes to agents.

Lead는 사용자와 직접 대화하는 메인 에이전트. tasks.json에서 `owner: "lead"`는 Lead가 직접 처리.

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
| nx-init | /claude-nexus:nx-init | Full project onboarding: scan codebase, establish identity, generate core knowledge |
| nx-plan | [plan] | Structured planning — subagent-based analysis, deliberate decisions, produce execution plan |
| nx-run | [run] | Execution — user-directed agent composition |
| nx-setup | /claude-nexus:nx-setup | Configure Nexus interactively |
| nx-sync | /claude-nexus:nx-sync | Synchronize core knowledge with current project state |

### Tags

| Tag | Purpose |
|-----|---------|
| [plan] | 계획 — 리서치, 다관점 분석, 결정, 계획서 생성 |
| [d] | 결정 기록 (plan 세션 내 nx_plan_decide 호출) |
| [run] | 실행 — 계획서 기반 서브에이전트 병렬 실행 |
| [rule] | 규칙 저장 — [rule:태그] 형식 지원 |
<!-- NEXUS:END -->
