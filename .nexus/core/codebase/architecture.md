<!-- tags: architecture, main-process, renderer, data-flow, store-factory -->
# Architecture Overview

## 3계층 구조

```
Electron Application
├── Main Process (Node.js)
│   ├── ControlPlane — CLI 통신 관장
│   │   ├── RunManager      — CLI spawn, NDJSON 스트림 파싱 (--include-partial-messages로 실시간 스트리밍)
│   │   ├── StreamParser     — NDJSON 라인별 메시지 타입 처리 (streamedTextLength로 중복 방지)
│   │   ├── HookServer       — HTTP 훅 서버 (PreToolUse/PostToolUse)
│   │   ├── PermissionHandler — 퍼미션 요청/응답 UI 연동
│   │   ├── SessionManager   — 세션 생성/저장/복원
│   │   ├── ApprovalStore    — 영구 승인 규칙 저장
│   │   ├── AgentTracker     — 에이전트 트리 구조 추적
│   │   └── CheckpointManager — git stash 기반 체크포인트
│   ├── PluginHost — 플러그인 매니페스트 로딩/관리
│   └── IPC Handlers — Main↔Renderer 채널 등록 (모든 이벤트에 sessionId 포함)
├── Preload — contextBridge API 노출
└── Renderer (React 19)
    ├── Components — layout, chat, workspace, permission, plugins, settings, shared
    ├── Stores (Zustand) — session (Store Factory), workspace, history, settings, permission, checkpoint, plugin, status-bar, changes
    ├── SessionStoreProvider — React Context로 활성 워크스페이스의 sessionStore 제공
    └── IPC Bridge — sessionId 기반 store 라우팅
```

## Session Store Factory 패턴

```
createSessionStore() — 워크스페이스별 독립 인스턴스 생성
├── 클로저 격리 상태: _textBuffer, _rafId, _toolCallIndex, msgCounter, evtCounter
├── 레지스트리: _workspaceStores (Map<path, store>), _sessionStores (Map<sessionId, store>)
├── Context: SessionStoreContext → useActiveSession() 훅
└── 비React 접근: getActiveStore() / getStoreBySessionId()
```

- 워크스페이스 전환 = Context 포인터 변경 (reset/restore 불필요)
- Always-Live: 모든 세션 스토어가 동시에 활성
- IPC 라우팅: getStoreBySessionId(sessionId) ?? getActiveStore()

## 데이터 흐름

1. **User → CLI**: ChatInput → useActiveSession → IPC → RunManager.send() → CLI stdin (NDJSON)
2. **CLI → User**: CLI stdout → StreamParser → IPC events (sessionId 포함) → ipc-bridge → getStoreBySessionId → store.appendTextChunk → rAF → StreamingMessage (적응형 드레인) → MarkdownRenderer
3. **Permission**: CLI → HTTP POST /hook → HookServer → PermissionHandler → IPC → PermissionCard → 사용자 응답 → HTTP response
4. **Plugin**: PluginHost file-watch → IPC plugin:data → plugin-store → NexusPanel/ChangesPanel
5. **Nexus 독립 IPC**: NEXUS_STATE_READ + NEXUS_STATE_CHANGED → .nexus/state/ 직접 읽기 (PluginHost 우회)

## 스트리밍 파이프라인

```
API SSE → CLI (--include-partial-messages) → stdout stream_event/text_delta
→ RunManager.bindProcessEvents → StreamParser.feed → emit text_chunk
→ handlers.ts webContents.send(TEXT_CHUNK, {text, sessionId})
→ ipc-bridge getStoreBySessionId → store.appendTextChunk
→ rAF 디바운스 → set(messages) → React re-render
→ StreamingMessage (displayedLength rAF 드레인, 적응형 charsPerFrame)
→ MarkdownRenderer (displayedContent 기준, 마크다운 구문 완성 시 포맷 적용)
→ 스트리밍 완료 시: 전체 content MarkdownRenderer 전환
```

## 세션 라이프사이클

```
idle → running → waiting_permission → running → ended | error
                                                  ↗
          error ─────────────────────────────────
```

세션 ID → RunManager 맵 (`Map<string, RunManager>`)으로 관리. 워크스페이스와 1:1 매핑.
워크스페이스 전환 시 RunManager cancel 안 함 (Always-Live).