<!-- tags: architecture, design, decisions, constraints, settings -->
<!-- tags: architecture, design, decisions, constraints, settings -->
# Design

## 핵심 아키텍처

Electron 3계층 구조:
- **Main Process**: ControlPlane (RunManager, HookServer, PermissionHandler, SessionManager) + PluginHost + IPC Handlers
- **Preload**: contextBridge API 노출
- **Renderer**: React 19 + Zustand + Tailwind CSS v4

## CLI 통신

`claude -p --input-format stream-json --output-format stream-json` subprocess 양방향 NDJSON 통신 + HTTP Hook Server (관찰/차단 가능, exit code 2).

## 기술 선택 이유

| 결정 | 선택 | 근거 |
|------|------|------|
| 런타임 | Electron | Chromium 일관성, Tauri/Electrobun은 WebKit 문제 |
| CLI 통신 | stream-json | 구조화된 NDJSON, Agent SDK는 API키 필수 |
| 확장성 | PluginHost | MVP부터 플러그인 프로토콜 |
| 패키지 | Bun | 빠른 설치, 런타임은 Node.js |
| UI | shadcn/ui + Ark UI | 커스터마이즈 + Tailwind 기반 |

## 설계 원칙 (4대 교차 패턴)

1. **Progressive Disclosure** — 4단계 정보 계층
2. **승인/제어권 스펙트럼** — 리스크 3단계 × 범위 4단계
3. **상태 기계 모델** — Session→Agent→Tool 계층 연동
4. **사전 승인/사후 복구 하이브리드** — 리스크 기반 분기

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

## 아키텍처 제약 (5개)

1. stream-json stdin은 user message만 전송 가능
2. PreToolUse 훅 exit code 2로 도구 차단 가능
3. 에디터 없는 채팅 래퍼 (인라인 편집 불가)
4. AskUserQuestion -p 모드 즉시 is_error 반환
5. CLI 프로젝트 루트는 git 루트 의존
