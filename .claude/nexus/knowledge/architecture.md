<!-- tags: architecture, electron, main-process, renderer, ipc, plugin, data-flow -->
<!-- tags: architecture, electron, main-process, renderer, ipc, plugin -->
# Architecture

## Overview

Nexus Code는 Claude Code CLI를 GUI로 래핑하는 Electron 데스크톱 앱이다. `claude -p --output-format stream-json` subprocess를 실행하여 NDJSON 스트림을 파싱하고, HTTP 훅 서버로 퍼미션을 인터셉트한다.

## 3-Process Model

### Main Process (`src/main/`)

CLI 통신과 시스템 자원을 관장하는 ControlPlane + 플러그인 시스템.

| 모듈 | 파일 | 역할 |
|------|------|------|
| **RunManager** | `run-manager.ts` | CLI subprocess spawn, StreamParser와 연동, 세션 라이프사이클 관리. 자동 재시작(최대 3회, exponential backoff 1/2/4초), 120초 activity timer, rate limit 시 타이머 일시정지 |
| **StreamParser** | `stream-parser.ts` | NDJSON 라인 파싱, `stream_event`(실시간 텍스트), `assistant`(tool_use), `tool_result`, `result`, `rate_limit_event` 등 메시지 타입 분류. 미처리 타입 debug 로깅 |
| **HookServer** | `hook-server.ts` | 로컬 HTTP 서버(포트 0 자동 할당). `POST /hook/pre-tool-use/{appSecret}/{runToken}` 엔드포인트. 이중 토큰 인증 |
| **PermissionHandler** | `permission-handler.ts` | 읽기 전용 도구 자동 승인(Read, Glob, Grep, LS + Bash 화이트리스트), 수동 승인 시 Promise 기반 대기(60초 타임아웃) |
| **SessionManager** | `session-manager.ts` | `~/.claude/projects/` 하위 JSONL 파일 스캔, 세션 목록/프리뷰 제공, fs.watch 기반 캐시 무효화 |
| **PluginHost** | `plugin-host.ts` | `plugins/` 하위 `manifest.json` 로드, file-watch 데이터소스 → Renderer에 `PLUGIN_DATA` IPC 이벤트 전송 |
| **AgentTracker** | `agent-tracker.ts` | HookServer의 `pre-tool-use` 이벤트로 에이전트별 tool call 추적, 타임라인 데이터를 `PLUGIN_DATA`로 broadcast |
| **Logger** | `logger.ts` | electron-log 기반 구조화 로깅 설정 |
| **CliRawLogger** | `cli-raw-logger.ts` | CLI stdout 원본 로그를 세션별 파일로 기록 |

진입점: `index.ts` — 위 모듈 초기화, IPC 핸들러 등록, BrowserWindow 생성.

### Preload (`src/preload/`)

`contextBridge.exposeInMainWorld('electronAPI', api)` — `invoke`, `on`, `off` 3개 메서드. WeakMap으로 리스너 매핑 관리.

`ipc-bridge.ts` — Renderer 측 IPC stream 이벤트 구독 중앙화 모듈. Main에서 전송하는 TEXT_CHUNK, TOOL_CALL, TOOL_RESULT, TIMEOUT, RATE_LIMIT 등의 이벤트를 Zustand 스토어에 연결.

### Renderer (`src/renderer/`)

React 19 + Zustand 5 기반 UI.

**레이아웃 구조:**
```
AppLayout (flex h-screen)
├── Sidebar (w-250px) — WorkspaceList
├── MainPanel (flex-1) — PermissionList + ChatPanel
└── RightPanel (w-350px) — Nexus | Markdown | Timeline 탭
```

**Zustand 스토어 6개:**

| 스토어 | 파일 | 관리 대상 |
|--------|------|-----------|
| `useSessionStore` | `session-store.ts` | 현재 세션 ID, 상태(idle/running/restarting/timeout/error/ended), 메시지 목록, 스트림 버퍼, dismissTimeout |
| `usePermissionStore` | `permission-store.ts` | 퍼미션 요청 큐 |
| `usePluginStore` | `plugin-store.ts` | 플러그인 패널 데이터 (`pluginId → panelId → data`) |
| `useWorkspaceStore` | `workspace-store.ts` | 워크스페이스 목록, 활성 워크스페이스 |
| `useHistoryStore` | `history-store.ts` | 세션 히스토리, 세션 복원 |
| `useSettingsStore` | `settings-store.ts` | 앱 설정 (모델, 퍼미션 모드 등) |

## IPC 채널

`src/shared/ipc.ts`에 채널명 상수 정의, `src/shared/types.ts`에 Request/Response/Event 타입 정의.

**Request-Response:** START, PROMPT, CANCEL, STATUS, LIST_SESSIONS, LOAD_SESSION, RESPOND_PERMISSION, WORKSPACE_LIST/ADD/REMOVE, `ipc:read-file`

**Stream Events (Main → Renderer):** TEXT_CHUNK, TOOL_CALL, TOOL_RESULT, PERMISSION_REQUEST, SESSION_END, TURN_END, ERROR, PLUGIN_DATA, RESTART_ATTEMPT, RESTART_FAILED, TIMEOUT, RATE_LIMIT

## 데이터 흐름

1. User → ChatInput → `ipc:start` (첫 메시지) 또는 `ipc:prompt` (후속)
2. Main → RunManager.start() → `claude -p --output-format stream-json` spawn
3. CLI stdout → StreamParser.feed() → 이벤트 emit → IPC로 Renderer에 전달
4. Renderer → Zustand 스토어 업데이트 → React 리렌더링
5. 퍼미션: CLI → HTTP POST → HookServer → PermissionHandler → IPC → PermissionCard UI → 사용자 응답 → HTTP 200

## PluginHost 프로토콜

`plugins/{name}/manifest.json`으로 패널 선언.

**데이터소스:** `file-watch`(JSON 파일 감시), `hook-events`(AgentTracker가 직접 처리)
**렌더러:** tree, timeline, markdown
**경로 플레이스홀더:** `{branch}` → 현재 git 브랜치로 치환

현재 유일한 플러그인: `nexus` — consult, decisions, tasks 3개 패널 (`.nexus/branches/{branch}/` 파일 감시).

## 워크스페이스 관리

`~/.nexus-code/workspaces.json`에 등록된 디렉토리 목록 영속화. native 폴더 선택 다이얼로그로 추가.
