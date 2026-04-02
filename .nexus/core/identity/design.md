<!-- tags: architecture, design, decisions, constraints, settings -->
# Design

## 제품 정체성

Nexus Code는 **에이전트 오케스트레이션 워크스테이션**이다. CLI 래퍼가 아닌 독자적인 도구로, 팀 미팅 워크플로우 GUI와 Mission Control 감독 대시보드를 핵심 차별점으로 삼는다.

- 검증 도구(코드 뷰어, 브라우저, 파일탐색기)는 에이전트 컨텍스트에 바인딩됨
- "찾아가는 UX"가 아닌 "따라오는 UX" — 에이전트 선택 → 관련 정보 자동 표시

## 핵심 아키텍처

Electron 3계층 구조:
- **Main Process**: ControlPlane (RunManager, HookServer, PermissionHandler, SessionManager) + PluginHost + IPC Handlers
- **Preload**: contextBridge API 노출
- **Renderer**: React 19 + Zustand + Tailwind CSS v4

## CLI 통신 (현재)

`claude -p --input-format stream-json --output-format stream-json` subprocess 양방향 NDJSON 통신 + HTTP Hook Server(관찰/차단 가능, exit code 2).

## AgentBackend 추상화 (Phase 4에서 도입 예정)

Phase 1-3에서는 현재 RunManager를 그대로 사용. Phase 4에서 API 백엔드 도입 시점에 **AgentBackend 인터페이스** 추상화를 통해 점진적으로 Anthropic API 직접 호출로 이행. Fork 방식(Claude Code 소스 포크)은 유지보수 비용으로 배제.

```
AgentBackend (인터페이스)
├── ClaudeCliBackend   ← 현재 (subprocess)
└── AnthropicApiBackend ← 점진적 전환 목표
```

## 기술 선택 이유

| 결정 | 선택 | 근거 |
|------|------|------|
| 런타임 | Electron | Chromium 내장 필수 — CMUX가 WKWebView 사용 시 렌더링 문제 실경험. Tauri/Swift 네이티브/Flutter는 macOS에서 WebKit 사용하므로 배제 |
| CLI 통신 | stream-json | 구조화된 NDJSON, AgentBackend 추상화 예정 |
| 확장성 | PluginHost | MVP부터 플러그인 프로토콜 |
| 패키지 | Bun | 빠른 설치, 런타임은 Node.js |
| UI | shadcn/ui + Ark UI | 커스터마이즈 + Tailwind 기반 |
| 내장 터미널 | xterm.js | 향후 부가 기능 (현재 미구현) |

## 설계 원칙

1. **Progressive Disclosure** — 4단계 정보 계층
2. **승인/제어권 스펙트럼** — 리스크 3단계 × 범위 4단계
3. **상태 기계 모델** — Session→Agent→Tool 계층 연동
4. **사전 승인/사후 복구 하이브리드** — 리스크 기반 분기
5. **컨텍스트 바인딩** — 에이전트 선택 시 관련 도구/정보 자동 연결
6. **오케스트레이션 우선** — 단일 대화가 아닌 에이전트 팀 조율이 기본 흐름

## Mission Control 레이아웃

### MVP 레이아웃 (Phase 1)

```
┌─────────┬──────────┬────────────┐
│ Agent   │ 통합     │ Chat +     │
│ Sidebar │ 승인 큐   │ Diff View  │
│ (200px) │          │            │
│ 상태카드 │ 권한요청  │ 에이전트   │
│ 리스트   │ 우선순위  │ 컨텍스트   │
│         │ 일괄승인  │ 바인딩     │
└─────────┴──────────┴────────────┘
```

### 완성형 레이아웃 (Phase 3+)

```
┌─────────┬──────────────────────────────┐
│ Agent   │ Mission Control 대시보드      │
│ Groups  │ (오케스트레이션 맵 + Gantt)    │
│         ├──────┬──────────┬────────────┤
│         │ Chat │ Editor   │ Browser    │
│         │      │ (diff)   │ (preview)  │
└─────────┴──────┴──────────┴────────────┘
```

- **Agent Sidebar**: 에이전트 상태 카드 — running/stopped, 경과 시간, 변경 파일 수
- **통합 승인 큐**: 크로스 에이전트 권한 요청 집중. 우선순위 정렬, 일괄/개별 승인
- **컨텍스트 바인딩**: 선택 에이전트의 Chat + Diff + Browser 자동 전환
- **모드 전환**: 감독 ↔ 검증은 포커스 이동에 따라 자연스럽게 리사이즈

## Settings SSOT 아키텍처

settings-store는 단일 진실 소스(SSOT)로 설계됨:

```
{ global, project, effective }
├── global  — ~/.claude/settings.json 로드
├── project — {workspace}/.claude/settings.json 로드
└── effective — computeEffective(global, project)
    ├── 일반 키: project가 global 오버라이드 (spread)
    └── 중첩 객체 (permissions, sandbox): deep merge (두 레벨 spread)
```

- **즉시 적용**: 저장 버튼 없음. updateSetting() 호출 시 store 갱신 + IPC 저장 동시 진행
- **프로젝트 키 삭제**: resetProjectSetting(key) → SETTINGS_DELETE_KEY IPC → 프로젝트 설정에서 키 제거 후 global 값으로 fallback
- **GUI 설정 통합**: theme, toolDensity, notificationsEnabled를 settings-store에 통합 (localStorage 마이그레이션 포함)
- **plain property**: model, permissionMode는 effective에서 파생된 plain Zustand property (reactive selector용)

## SettingsModal 6카테고리 구조

680px 고정 폭, 좌측 네비 + 우측 콘텐츠 레이아웃:

| 카테고리 | 패널 | 주요 설정 |
|----------|------|-----------|
| 모델 및 응답 | panel-model | model, effortLevel, outputStyle, alwaysThinkingEnabled |
| 외관 | panel-appearance | theme (6개 스와치), toolDensity, notificationsEnabled, prefersReducedMotion |
| 권한 | panel-permissions | permissionMode, allow/deny 목록 |
| 플러그인 | panel-plugins | enabledPlugins |
| 환경 | panel-environment | env vars, defaultShell, includeGitInstructions |
| 고급 | panel-advanced | sandbox, cleanupPeriodDays, teammateMode, skipDangerousModePermissionPrompt |

## 전역/워크스페이스 설정 분리

- **세그먼트 컨트롤** (상단): 전역 설정 / 워크스페이스 설정 전환 (워크스페이스 없으면 비활성)
- **scope**: 각 패널은 현재 scope(global|project)를 기준으로 읽기/쓰기
- **effective 표시**: 실제 적용 값은 effective에서 읽어 렌더링, 편집은 scope별로 기록
- **패널 공유 인터페이스** (settings-shared.tsx): `PanelProps = { scope, global, project, effective, onUpdate, onReset }`

## 모델 빠른 전환

- **ModelSwitcher** (ChatInput 영역): 현재 모델 뱃지 클릭 → 드롭다운 → setModel() 호출
- **CommandPalette**: 모델 전환/effort 전환 명령 포함
- **MODEL_ALIASES** (src/renderer/lib/models.ts): ModelId → 표시명 매핑, ModelSwitcher/CommandPalette에서 공유

## 아키텍처 제약

1. stream-json stdin은 user message만 전송 가능
2. PreToolUse 훅 exit code 2로 도구 차단 가능
3. 에디터 없는 채팅 래퍼 (인라인 편집 불가) — 검증 도구는 별도 패널
4. AskUserQuestion -p 모드 즉시 is_error 반환
5. CLI 프로젝트 루트는 git 루트 의존
