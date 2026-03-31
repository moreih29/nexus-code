<!-- tags: structure, directories, files, modules, logging, settings -->
<!-- tags: structure, directories, files, modules, logging, settings -->
# Source Structure

## 디렉토리 레이아웃

```
src/
├── main/                           # Electron Main Process
│   ├── index.ts                    # 앱 진입점, BrowserWindow, 서비스 초기화, 세션 로그 정리
│   ├── logger.ts                   # 구조화 로깅 시스템 (11개 카테고리, 세션별 파일 분리)
│   ├── control-plane/
│   │   ├── run-manager.ts          # CLI subprocess spawn + NDJSON 스트림 + --include-partial-messages + --effort 플래그
│   │   ├── stream-parser.ts        # NDJSON 라인 파서 (streamedTextLength 중복 방지, sessionId 전달)
│   │   ├── hook-server.ts          # HTTP 훅 서버 (PreToolUse/PostToolUse)
│   │   ├── permission-handler.ts   # 퍼미션 UI 연동
│   │   ├── session-manager.ts      # 세션 생성/저장/복원
│   │   ├── approval-store.ts       # 영구 승인 규칙
│   │   ├── agent-tracker.ts        # 에이전트 트리 추적
│   │   ├── checkpoint-manager.ts   # git stash 체크포인트
│   │   └── cli-raw-logger.ts       # CLI 원시 출력 로깅 (세션별 파일 분리)
│   ├── plugin-host/
│   │   ├── index.ts                # 플러그인 로더/관리자
│   │   └── loader.ts               # manifest.json 파서
│   └── ipc/
│       └── handlers.ts             # IPC 핸들러 등록 (모든 이벤트에 sessionId 포함)
├── preload/
│   └── index.ts                    # contextBridge (invoke, on, off)
├── renderer/
│   ├── index.html                  # HTML 진입점
│   ├── main.tsx                    # React 진입점
│   ├── App.tsx                     # 루트 컴포넌트 + SessionStoreProvider + ErrorBoundary
│   ├── app.css                     # Tailwind v4 + 6개 테마 변수 + 스트리밍 커서/fade 애니메이션
│   ├── ipc-bridge.ts               # sessionId 기반 store 라우팅 (getStoreBySessionId ?? getActiveStore)
│   ├── lib/
│   │   ├── utils.ts                # cn() 유틸
│   │   └── models.ts               # MODEL_ALIASES (ModelId → 표시명 매핑, ModelSwitcher/CommandPalette 공유)
│   ├── components/
│   │   ├── layout/                 # AppLayout, Sidebar, MainPanel, RightPanel
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx       # 채팅 패널
│   │   │   ├── ChatInput.tsx       # 입력 + ModelSwitcher 영역
│   │   │   ├── model-switcher.tsx  # 모델 빠른 전환 (뱃지 + 드롭다운)
│   │   │   ├── MessageBubble.tsx   # 메시지 버블
│   │   │   ├── StreamingMessage.tsx # 스트리밍 메시지
│   │   │   ├── ToolRenderer.tsx    # 도구 호출 렌더러
│   │   │   ├── CodeBlock.tsx       # 코드 블록
│   │   │   ├── MarkdownRenderer.tsx # 마크다운 렌더러
│   │   │   └── StatusBar.tsx       # 상태 바
│   │   ├── workspace/              # WorkspaceList, WorkspaceItem, AddWorkspaceButton
│   │   ├── history/                # SessionList, SessionItem, NewSessionButton
│   │   ├── permission/             # PermissionCard, PermissionList
│   │   ├── plugins/                # AgentTimeline, ChangesPanel, NexusPanel, MarkdownViewer
│   │   ├── settings/
│   │   │   ├── SettingsModal.tsx   # 설정 모달 (680px, 좌측 6카테고리 네비 + 전역/워크스페이스 세그먼트)
│   │   │   ├── settings-shared.tsx # 공유 타입/유틸 (Scope 타입, PanelProps 인터페이스)
│   │   │   ├── panel-model.tsx     # 모델 및 응답 패널 (model, effortLevel, outputStyle 등)
│   │   │   ├── panel-appearance.tsx # 외관 패널 (theme, toolDensity, notifications)
│   │   │   ├── panel-permissions.tsx # 권한 패널 (permissionMode, allow/deny 목록)
│   │   │   ├── panel-plugins.tsx   # 플러그인 패널 (enabledPlugins)
│   │   │   ├── panel-environment.tsx # 환경 패널 (env vars, defaultShell)
│   │   │   └── panel-advanced.tsx  # 고급 패널 (sandbox, includeGitInstructions, cleanupPeriodDays 등)
│   │   ├── shared/                 # CommandPalette (모델/effort 전환 명령 포함), DiffView
│   │   └── ui/                     # shadcn 컴포넌트 (badge, button, card, collapsible)
│   └── stores/
│       ├── session-store.ts        # Store Factory (createSessionStore + 레지스트리 + Context + useActiveSession)
│       ├── workspace-store.ts      # 워크스페이스 목록
│       ├── history-store.ts        # 세션 히스토리
│       ├── settings-store.ts       # SSOT: { global, project, effective } + model/permissionMode plain property + GUI 설정 통합
│       ├── permission-store.ts     # 퍼미션 큐
│       ├── checkpoint-store.ts     # 체크포인트 (getActiveStore 사용)
│       ├── plugin-store.ts         # 플러그인 데이터 + RightPanelUIStore (cleanup 포함)
│       ├── status-bar-store.ts     # StatusBar 상태
│       └── changes-store.ts        # 파일 변경 추적
└── shared/
    ├── types.ts                    # IPC 메시지 타입 (ClaudeSettings 확장: model, effortLevel, outputStyle, teammateMode, sandbox 등)
    └── ipc.ts                      # IPC 채널 이름 상수 (SETTINGS_DELETE_KEY, NEXUS_STATE_READ/CHANGED 포함)

## 로그 파일 구조

```
~/Library/Logs/nexus-code/          # app.getPath('logs') 기반
├── main.log                        # 글로벌 이벤트 (앱 생명주기, 설정, 플러그인)
├── main.{timestamp}.log            # main.log 아카이브 (10MB 로테이션, 최근 5개)
└── sessions/                       # 세션별 로그
    ├── session-{sessionId}.log     # 세션별 구조화 로그 (cli, stream, hook, permission, agent, checkpoint)
    └── cli-raw-{sessionId}.log     # 세션별 CLI stdout 원본
```

## 기타 디렉토리

- `plugins/nexus/` — Nexus 플러그인 manifest.json (.nexus/state/ 경로)
- `e2e/` — Playwright E2E 테스트
- `.nexus/` — Nexus 런타임 상태 (state/, core/, history.json, rules/)
