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

### Agent Routing

병렬 작업이나 다른 관점이 필요할 때 에이전트를 활용하라.

| Task | Agent |
|------|-------|
| Architecture, technical design, code review | architect |
| Project direction, scope, priorities | director |
| Code implementation, edits, debugging | engineer |
| Research methodology, evidence synthesis | postdoc |
| Research direction, agenda, bias prevention | principal |
| Testing, verification, security review | qa |
| Web search, independent investigation | researcher |

단순 작업(파일 1-2개 읽기/수정)은 직접 처리하라.

### Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| nx-consult | [consult] | Interactive discovery — understand intent before executing |
| nx-dev | [dev] / [dev!] | Development execution — sub-agent or team mode |
| nx-research | [research] / [research!] | Research execution — principal+postdoc+researcher team |
| nx-setup | /claude-nexus:nx-setup | Configure Nexus interactively |
| nx-sync | /claude-nexus:nx-sync | Sync knowledge docs with source files (first run = auto-generate) |

### Tags

| Tag | Purpose |
|-----|---------|
| [consult] | 상담 — 실행 전 의도 파악 |
| [dev] | 개발 — Lead 자율 판단 (sub 또는 team) |
| [dev!] | 개발 팀 강제 — 반드시 팀 구성 |
| [research] | 리서치 — Lead 자율 판단 (sub 또는 team) |
| [research!] | 리서치 팀 강제 — 반드시 팀 구성 |
| [d] | 결정 기록 (nx_decision_add 호출) |
<!-- NEXUS:END -->
