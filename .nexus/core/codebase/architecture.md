<!-- tags: architecture, main-process, renderer, data-flow -->
# Architecture Overview

## 3계층 구조

```
Electron Application
├── Main Process (Node.js)
│   ├── ControlPlane — CLI 통신 관장
│   │   ├── RunManager      — CLI spawn, NDJSON 스트림 파싱
│   │   ├── StreamParser     — NDJSON 라인별 메시지 타입 처리
│   │   ├── HookServer       — HTTP 훅 서버 (PreToolUse/PostToolUse)
│   │   ├── PermissionHandler — 퍼미션 요청/응답 UI 연동
│   │   ├── SessionManager   — 세션 생성/저장/복원
│   │   ├── ApprovalStore    — 영구 승인 규칙 저장
│   │   ├── AgentTracker     — 에이전트 트리 구조 추적
│   │   └── CheckpointManager — git stash 기반 체크포인트
│   ├── PluginHost — 플러그인 매니페스트 로딩/관리
│   └── IPC Handlers — Main↔Renderer 채널 등록
├── Preload — contextBridge API 노출
└── Renderer (React 19)
    ├── Components — layout, chat, workspace, permission, plugins, settings, shared
    ├── Stores (Zustand) — session, workspace, history, settings, permission, checkpoint, plugin, status-bar, changes
    └── IPC Bridge — electronAPI 래퍼
```

## 데이터 흐름

1. **User → CLI**: ChatInput → session-store → IPC → RunManager.send() → CLI stdin (NDJSON)
2. **CLI → User**: CLI stdout → StreamParser → IPC events → Zustand stores → React re-render
3. **Permission**: CLI → HTTP POST /hook → HookServer → PermissionHandler → IPC → PermissionCard → 사용자 응답 → HTTP response
4. **Plugin**: PluginHost file-watch → IPC plugin:data → plugin-store → NexusPanel/ChangesPanel

## 세션 라이프사이클

```
idle → running → waiting_permission → running → ended | error
                                                  ↗
          error ─────────────────────────────────
```

세션 ID → RunManager 맵 (`Map<string, RunManager>`)으로 관리. 워크스페이스와 1:1 매핑.