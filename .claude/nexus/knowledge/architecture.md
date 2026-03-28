<!-- tags: architecture, electron, main-process, renderer, ipc, plugin, data-flow -->
<!-- tags: architecture, electron, main-process, renderer, ipc, plugin, data-flow -->
# Architecture

## Overview

Nexus Code는 Claude Code CLI를 GUI로 래핑하는 Electron 데스크톱 앱이다. `claude -p --output-format stream-json --verbose` subprocess를 실행하여 NDJSON 스트림을 파싱한다. 퍼미션 처리는 `--dangerously-skip-permissions` + PreToolUse 훅(exit code 2) 기반으로 구현됨. 사용자 거부 시 훅이 exit 2를 반환하여 도구 실행을 차단한다.

## 3-Process Model

### Main Process (`src/main/`)

CLI 통신과 시스템 자원을 관장하는 ControlPlane + 플러그인 시스템 + IPC 핸들러.

#### control-plane/

| 모듈 | 파일 | 역할 |
|------|------|------|
| **RunManager** | `control-plane/run-manager.ts` | CLI subprocess spawn, StreamParser와 연동, 세션 라이프사이클 관리. 자동 재시작(최대 3회, exponential backoff 1/2/4초), 120초 activity timer, rate limit 시 타이머 일시정지. `sendPrompt(message, images?)` — 이미지 첨부 시 content 배열에 image 블록(`type:'image', source:{type:'base64', ...}`) 구성 |
| **StreamParser** | `control-plane/stream-parser.ts` | NDJSON 라인 파싱, `stream_event`(실시간 텍스트), `assistant`(tool_use), `user`(tool_result), `result`, `rate_limit_event` 등 메시지 타입 분류. tool_result는 `type:"user"` 메시지 내부에 포함됨 |
| **HookServer** | `control-plane/hook-server.ts` | 로컬 HTTP 서버(포트 0 자동 할당). `POST /hook/pre-tool-use/{appSecret}/{runToken}` 엔드포인트. 이중 토큰 인증 |
| **PermissionHandler** | `control-plane/permission-handler.ts` | 읽기 전용 도구 자동 승인(Read, Glob, Grep, LS + Bash 화이트리스트), 수동 승인 시 Promise 기반 대기(60초 타임아웃) |
| **CheckpointManager** | `control-plane/checkpoint-manager.ts` | git stash 기반 체크포인트 생성/복원. `restoreCheckpoint()` — 복원 전 `git stash show --name-only`로 변경 파일 목록 획득, `CheckpointRestoreInfo { changedFiles: string[], shortHash: string }` 반환. 커밋 없는 repo는 null 반환 |
| **ApprovalStore** | `control-plane/approval-store.ts` | 영구 승인 규칙 관리. `~/.nexus-code/permissions-global.json` 읽기/쓰기 |
| **SessionManager** | `control-plane/session-manager.ts` | `~/.claude/projects/` 하위 JSONL 파일 스캔, 세션 목록/프리뷰 제공, fs.watch 기반 캐시 무효화 |
| **AgentTracker** | `control-plane/agent-tracker.ts` | HookServer의 `pre-tool-use` 이벤트로 에이전트별 tool call 추적 + SubagentStart/Stop 생명주기 관리. `agent_id` 파싱으로 parent/sub-agent 도구 호출 분리. `computeStatus(agentId)`로 idle/running/error 상태 파생, 타임라인 데이터를 `PLUGIN_DATA`로 broadcast |
| **CliRawLogger** | `control-plane/cli-raw-logger.ts` | CLI stdout 원본 로그를 세션별 파일로 기록 |

#### plugin-host/

| 모듈 | 파일 | 역할 |
|------|------|------|
| **PluginHost** | `plugin-host/index.ts` | `plugins/` 하위 `manifest.json` 로드, file-watch 데이터소스 → Renderer에 `PLUGIN_DATA` IPC 이벤트 전송 |
| **Loader** | `plugin-host/loader.ts` | 플러그인 manifest 파싱 및 검증 |

#### ipc/

| 모듈 | 파일 | 역할 |
|------|------|------|
| **IPC Handlers** | `ipc/handlers.ts` | `IpcDeps` 인터페이스로 의존성 주입받아 모든 IPC 핸들러 등록 + stream event 포워딩. 모듈 스코프 `notificationsEnabled` 변수로 알림 상태 관리 |

#### 기타

| 모듈 | 파일 | 역할 |
|------|------|------|
| **Logger** | `logger.ts` | electron-log 기반 구조화 로깅 설정 |

진입점: `index.ts` (94줄) — 모듈 초기화, `IpcDeps` 조립, `registerIpcHandlers(deps)` 호출, BrowserWindow 생성.

### Preload (`src/preload/`)

`contextBridge.exposeInMainWorld('electronAPI', api)` — `invoke`, `on`, `off` 3개 메서드. WeakMap으로 리스너 매핑 관리. 채널 필터링 없이 모든 채널 통과.

### Renderer (`src/renderer/`)

React 19 + Zustand 5 기반 UI.

**레이아웃 구조:**
```
AppLayout (flex h-screen)
├── Sidebar (w-250px, overlay 모드: absolute + backdrop)
│   └── WorkspaceList (호버 X 삭제 + ~/경로 표시)
├── MainPanel (flex-1) — PermissionList + ChatPanel
├── RightPanel (w-350px, forceCollapsed 시 숨김)
│   └── Nexus | Changes | Markdown | Timeline 탭
├── CommandPalette (CMD-K 모달, cmdk 기반)
└── 햄버거 버튼 (isNarrow일 때만 표시, Sidebar 토글)
```

**반응형 레이아웃:**
- `<900px` (isCompact): RightPanel `forceCollapsed` → 자동 숨김
- `<700px` (isNarrow): Sidebar 오버레이 모드 (absolute position + backdrop-dim) + 햄버거 토글 버튼
- CSS 미디어 쿼리 + matchMedia 리스너 하이브리드

**ChatPanel 내부 구조:**
```
ChatPanel
├── 메시지 목록 (MessageBubble × N)
├── StatusBar (메시지와 입력 사이 고정 영역)
└── ChatInput (입력 + 전송/중지 버튼 + 이미지 첨부)
```

**ipc-bridge.ts** — Renderer 측 IPC stream 이벤트 구독 중앙화 모듈. Main에서 전송하는 TEXT_CHUNK, TOOL_CALL, TOOL_RESULT, TURN_END, SESSION_END 등의 이벤트를 Zustand 스토어에 연결. TOOL_CALL에서 TodoWrite/AskUserQuestion을 감지하여 StatusBar 스토어에 라우팅.

**Zustand 스토어 10개:**

| 스토어 | 파일 | 관리 대상 |
|--------|------|-----------|
| `useSessionStore` | `session-store.ts` | 현재 세션 ID, 상태(idle/running/restarting/timeout/error/ended), 메시지 목록, 스트림 버퍼, dismissTimeout, `sendResponse()` (AskUserQuestion 응답), systemEvents(복원 구분선), lastTurnStats(턴별 토큰/비용), `removeMessagesAfter(timestamp)` (체크포인트 복원 시 이후 메시지+이벤트 삭제) |
| `useStatusBarStore` | `status-bar-store.ts` | StatusBar 상태 — todos(TodoWrite 체크리스트), askQuestion(AskUserQuestion 질문+옵션). TURN_END 시 유지, SESSION_END 시 clearAll |
| `usePermissionStore` | `permission-store.ts` | 퍼미션 요청 큐 |
| `usePluginStore` | `plugin-store.ts` | 플러그인 패널 데이터 (`pluginId → panelId → data`) |
| `useWorkspaceStore` | `workspace-store.ts` | 워크스페이스 목록, 활성 워크스페이스 |
| `useHistoryStore` | `history-store.ts` | 세션 히스토리, 세션 복원 |
| `useSettingsStore` | `settings-store.ts` | 앱 설정 (모델, 퍼미션 모드, notificationsEnabled). localStorage 영속화 + 앱 시작 시 main process에 초기 동기화(`SETTINGS_SYNC` IPC) |
| `useChangesStore` | `changes-store.ts` | 파일 변경 추적 (Edit/Write 도구 결과). `trackChange()`, `clear()` |
| `useCheckpointStore` | `checkpoint-store.ts` | 체크포인트 상태. git stash 기반 생성/복원/목록, `isGitRepo` 플래그. 복원 시 `{ ok, changedFiles, shortHash }` 반환 |

**주요 컴포넌트:**

| 컴포넌트 | 파일 | 역할 |
|----------|------|------|
| StatusBar | `chat/StatusBar.tsx` | 대화 외 상호작용 영역. TodoWrite 체크리스트 + AskUserQuestion 질문 버튼 표시. running 상태이거나 데이터 있을 때만 표시 |
| ToolRenderer | `chat/ToolRenderer.tsx` | 도구별 특화 ToolCard 렌더링. Collapsible + StatusBadge. TodoWrite/AskUserQuestion은 대화 영역에서 필터링됨 |
| CodeBlock | `chat/CodeBlock.tsx` | PrismLight + oneDark 구문 강조. 20개 언어 지원, 복사 버튼 |
| ChatInput | `chat/ChatInput.tsx` | 채팅 입력 + 이미지 드래그앤드롭 첨부. png/jpg/gif/webp 지원, 5MB 제한, 썸네일 미리보기 칩, FileReader base64 변환 |
| AgentTimeline | `plugins/AgentTimeline.tsx` | 에이전트별 상태 도트(idle=회색, running=파란색 점멸, error=빨간색) + 도구 사용 타임라인. 유형 필터 바(도구별 토글), HH:MM:SS 타임스탬프, sub-agent 트리 구조(agent_id 기반 계층 렌더링) |
| CheckpointBar | `chat/CheckpointBar.tsx` | 체크포인트 복원 버튼. HH:MM 시점 표시, confirm 후 복원, 이후 메시지 삭제(`removeMessagesAfter`), 구분선 마커 삽입("{hash} · {시간} 시점으로 복원") |
| CommandPalette | `shared/CommandPalette.tsx` | CMD-K 커맨드 팔레트. cmdk 기반, 새 세션/설정/히스토리 등 5개 커맨드 |
| DiffView | `shared/DiffView.tsx` | Edit/Write diff 뷰. 빨강(삭제)/초록(추가) 블록. PermissionCard, ChangesPanel에서 재사용 |
| ChangesPanel | `plugins/ChangesPanel.tsx` | RightPanel Changes 탭. 파일별 변경 그룹화, DiffView 재사용 |

**shadcn/ui 컴포넌트** (`components/ui/`): button, badge, card, collapsible, toggle — Radix 기반, `cn()` 유틸(`lib/utils.ts`) 사용.

## IPC 채널

`src/shared/ipc.ts`에 채널명 상수 정의, `src/shared/types.ts`에 Request/Response/Event 타입 정의.

**Request-Response:** START, PROMPT, CANCEL, STATUS, LIST_SESSIONS, LOAD_SESSION, RESPOND_PERMISSION, WORKSPACE_LIST/ADD/REMOVE, `ipc:read-file`, CHECKPOINT_CREATE, CHECKPOINT_RESTORE, CHECKPOINT_LIST, GIT_CHECK, GIT_INIT, SETTINGS_SYNC

**Stream Events (Main → Renderer):** TEXT_CHUNK, TOOL_CALL, TOOL_RESULT, PERMISSION_REQUEST, SESSION_END, TURN_END, ERROR, PLUGIN_DATA, RESTART_ATTEMPT, RESTART_FAILED, TIMEOUT, RATE_LIMIT

## 데이터 흐름

1. User → ChatInput → `ipc:start` (첫 메시지) 또는 `ipc:prompt` (후속). 이미지 첨부 시 `images: ImageAttachment[]` 포함
2. Main → RunManager.start() → `claude -p --output-format stream-json --verbose` spawn
3. CLI stdout → StreamParser.feed() → 이벤트 emit → IPC로 Renderer에 전달
4. Renderer → ipc-bridge.ts → Zustand 스토어 업데이트 → React 리렌더링
5. 퍼미션: `--dangerously-skip-permissions` + PreToolUse 훅. settings.local.json에 `curl -sf ... || exit 2` 훅 등록 → HookServer에서 approve/deny 판정 → deny 시 curl 실패 + exit 2 → CLI가 도구 차단. 3단계 승인: once/session/permanent
6. StatusBar: TOOL_CALL(TodoWrite) → statusBarStore.setTodos() / TOOL_CALL(AskUserQuestion) → statusBarStore.setAskQuestion() → StatusBar UI

### AskUserQuestion 우회 흐름 (-p 모드)

`-p` 모드에서 AskUserQuestion은 즉시 에러(`is_error:true`, `"Answer questions?"`)를 반환. GUI 래퍼에서 우회 처리:
1. tool_call → StatusBar에 질문+옵션 버튼 표시 (대화 영역에서 필터링)
2. 사용자 버튼 클릭 → `sendResponse("[AskUserQuestion] {질문} → {선택}")` → 새 메시지로 전송
3. TURN_END 시 StatusBar 상태 유지, SESSION_END 시 clearAll

### 파일 첨부 흐름

1. ChatInput에서 이미지 드래그앤드롭 → FileReader.readAsDataURL()로 base64 변환
2. 5MB 초과 시 인라인 에러, 지원 형식: png/jpg/jpeg/gif/webp
3. 전송 시 `handleSend(text, images)` → IPC `PROMPT`/`START`에 images 포함
4. RunManager.sendPrompt() → stream-json content 배열에 `{ type: 'image', source: { type: 'base64', media_type, data } }` 블록 추가

## 알림 시스템

Main process에서 Electron `Notification` API로 시스템 알림 발송.

- **트리거**: `turn_end`(작업 완료), `error`(오류 발생)
- **조건**: `BrowserWindow.isFocused() === false` + `notificationsEnabled === true`
- **설정**: 모듈 스코프 `notificationsEnabled` 변수 (handlers.ts). Renderer의 settings-store가 `SETTINGS_SYNC` IPC로 값 동기화. 앱 시작 시 localStorage에서 읽은 초기값도 동기화.
- **주의**: cmux 환경에서는 cmux 자체가 CLI 출력을 감지하여 별도 알림을 표시할 수 있음 — 독립 빌드로 검증 필요

## PluginHost 프로토콜

`plugins/{name}/manifest.json`으로 패널 선언.

**데이터소스:** `file-watch`(JSON 파일 감시), `hook-events`(AgentTracker가 직접 처리)
**렌더러:** tree, timeline, markdown
**경로 플레이스홀더:** `{branch}` → 현재 git 브랜치로 치환

현재 유일한 플러그인: `nexus` — consult, decisions, tasks 3개 패널 (`.nexus/branches/{branch}/` 파일 감시).

## 워크스페이스 관리

`~/.nexus-code/workspaces.json`에 등록된 디렉토리 목록 영속화. native 폴더 선택 다이얼로그로 추가.