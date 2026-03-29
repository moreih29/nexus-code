<!-- tags: structure, directories, files, modules -->
# Source Structure

## 디렉토리 레이아웃

```
src/
├── main/                           # Electron Main Process
│   ├── index.ts                    # 앱 진입점, BrowserWindow, 서비스 초기화
│   ├── logger.ts                   # electron-log 설정
│   ├── control-plane/
│   │   ├── run-manager.ts          # CLI subprocess spawn + NDJSON 스트림
│   │   ├── stream-parser.ts        # NDJSON 라인 파서
│   │   ├── hook-server.ts          # HTTP 훅 서버 (PreToolUse/PostToolUse)
│   │   ├── permission-handler.ts   # 퍼미션 UI 연동
│   │   ├── session-manager.ts      # 세션 생성/저장/복원
│   │   ├── approval-store.ts       # 영구 승인 규칙
│   │   ├── agent-tracker.ts        # 에이전트 트리 추적
│   │   ├── checkpoint-manager.ts   # git stash 체크포인트
│   │   └── cli-raw-logger.ts       # CLI 원시 출력 로깅
│   ├── plugin-host/
│   │   ├── index.ts                # 플러그인 로더/관리자
│   │   └── loader.ts               # manifest.json 파서
│   └── ipc/
│       └── handlers.ts             # IPC 핸들러 등록
├── preload/
│   └── index.ts                    # contextBridge (invoke, on, off)
├── renderer/
│   ├── index.html                  # HTML 진입점
│   ├── main.tsx                    # React 진입점
│   ├── App.tsx                     # 루트 컴포넌트
│   ├── app.css                     # Tailwind v4 + 테마 변수 + 커스텀 스타일
│   ├── ipc-bridge.ts               # electronAPI 래퍼
│   ├── lib/utils.ts                # cn() 유틸
│   ├── components/
│   │   ├── layout/                 # AppLayout, Sidebar, MainPanel, RightPanel
│   │   ├── chat/                   # ChatPanel, ChatInput, MessageBubble, ToolRenderer, CodeBlock, MarkdownRenderer, StatusBar
│   │   ├── workspace/              # WorkspaceList, WorkspaceItem, AddWorkspaceButton
│   │   ├── history/                # SessionList, SessionItem, NewSessionButton
│   │   ├── permission/             # PermissionCard, PermissionList
│   │   ├── plugins/                # AgentTimeline, ChangesPanel, NexusPanel, MarkdownViewer
│   │   ├── settings/               # SettingsModal
│   │   ├── shared/                 # CommandPalette, DiffView
│   │   └── ui/                     # shadcn 컴포넌트 (badge, button, card, collapsible)
│   └── stores/
│       ├── session-store.ts        # 세션 상태 + 메시지
│       ├── workspace-store.ts      # 워크스페이스 목록
│       ├── history-store.ts        # 세션 히스토리
│       ├── settings-store.ts       # 설정 (global/project)
│       ├── permission-store.ts     # 퍼미션 큐
│       ├── checkpoint-store.ts     # 체크포인트
│       ├── plugin-store.ts         # 플러그인 데이터
│       ├── status-bar-store.ts     # StatusBar 상태
│       └── changes-store.ts        # 파일 변경 추적
└── shared/
    ├── types.ts                    # IPC 메시지 타입, 도메인 타입
    └── ipc.ts                      # IPC 채널 이름 상수

## 기타 디렉토리

- `docs/` — ROADMAP.md, design-principles.md, stream-json-protocol.md, research/
- `plugins/nexus/` — Nexus 플러그인 manifest.json
- `e2e/` — Playwright E2E 테스트
- `.nexus/` — Nexus 런타임 상태 (branches/, state/)
```