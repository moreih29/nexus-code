# Workspace UI Fix — 미완료 기록

> 브랜치 `fix/workspace-ui-reset`, 최신 commit `a13252d`. 2026-04-14 진단 반복 끝에 **근본 원인 미특정 상태로 보류**.

---

## 해결된 증상 (확정)

1. ✅ **"+" 버튼 무반응** — `lib/electron.ts`의 `window.electronAPI` 분기가 Cycle C 후 영구 false였음. Tauri `invoke('select_folder')` IPC로 교체 (commit `b58dec6`).
2. ✅ **워크스페이스 전체 삭제 시 채팅 잔존** — `useChatSession`에 `workspacePath` 변경 감지 effect 추가로 `resetSession()` 선행 (commit `b58dec6`).
3. ✅ **resume API 직후 첫 이벤트 누락** — SSE `enabled` 조건에서 `hasSession` 제거, `supervisor.onGroupCreated` 이벤트 기반 구독으로 polling race 제거 (commit `b31d0b3`, `72e836b`).

## 미해결 증상 (보류)

**turn_end 후 두 번째 메시지의 응답이 UI에 렌더되지 않음.**

### 확정된 사실 (workspace log 2026-04-14 04:20~04:21 기준)

- 첫 턴은 **완벽 작동**: `_diag_group_created_cb` + `_diag_subscribe_group` → `session_init` + `text_delta × 8` + `turn_end` 모두 기록.
- `turn_end` (04:20:58) **15초 뒤 `sse_disconnect` 기록** (04:21:13).
- 이후 **재연결 `sse_connect` 기록이 없음**.
- 사용자가 두 번째 프롬프트 전송 시점(04:21:23) server에 `session_prompt` 정상 기록되지만, SSE 리스너 부재로 UI 미도달.

### 의심 가설 (미확정)

1. **Tauri WKWebView가 idle EventSource를 silent drop** — `EventSource.onerror`가 발화하지 않아 기존 reconnect 경로가 트리거 안 됨.
2. **useSse effect cleanup이 어떤 state 변경으로 유발** — `[workspacePath, enabled, queryClient]` deps 중 어느 것이 bgdmf 변경됐을 가능성.

### 적용된 방어 조치 (commit `a13252d`)

- `EventSource.readyState === CLOSED` 감지용 3초 watchdog → 500ms 후 강제 재연결.
- `[use-sse] effect mount/cleanup`, `[use-sse] watchdog: readyState CLOSED`, `[use-sse] onerror → reconnect in Xms, readyState was N` 진단 로그.
- 다만 사용자 Tauri 창에서 watchdog 효과 실측 결과 **여전히 응답 미수신** 확인됨 — watchdog 경로도 뭔가 막히고 있거나, 두 번째 resume API가 서버에서 process 추가를 다른 경로로 하고 있을 가능성.

## 남은 진단 경로

다음 cycle에서 확인할 것:

1. **사용자 DevTools에서 `[use-sse] watchdog` 로그가 찍혔는지** — 찍혔다면 재연결 시도는 됐지만 서버 측 매칭 실패(onGroupCreated 다시 등록됐지만 process가 이미 존재하여 emit 안됨)
2. **두 번째 프롬프트(`session_prompt` API)가 새 CliProcess를 spawn하는지 vs 기존 process에 stdin write하는지** — server session lifecycle 확인
3. **기존 process가 turn_end 후 group에서 제거되는지** — workspace-group의 removeProcess 트리거 조건 확인
4. **`[use-sse] effect cleanup`이 언제 찍히는지** — 어떤 deps 변경이 cleanup 유발하는지 역추적

## 현재 상태의 진단 로그 정리

다음 cycle에서 근본 원인 확정 후 **모두 제거** 대상:

- `packages/web/src/api/use-sse.ts`: `[use-sse] effect mount/cleanup`, `raw event`, `dispatch`, `schema fail`, `onerror`, `watchdog`
- `packages/web/src/stores/chat-store.ts`: `[chat-store] applyServerEvent` 로그
- `packages/web/src/components/chat/chat-area.tsx`: `[chat-area] resetSession effect fired`
- `packages/server/src/routes/events.ts`: `sse_connect`/`sse_disconnect`/`_diag_*` workspaceLogger 기록 6종

## 파일 레퍼런스

- 브랜치: `fix/workspace-ui-reset` (base: `feat/tauri-phase2-cycle-c`)
- 관련 commits: `b58dec6`, `b31d0b3`, `72e836b`, `f0f1a9b`, `a13252d`
- 관련 코드:
  - `packages/web/src/api/use-sse.ts`
  - `packages/web/src/lib/electron.ts`
  - `packages/web/src/components/chat/chat-area.tsx`
  - `packages/server/src/routes/events.ts`
  - `packages/server/src/adapters/claude-code/process-supervisor.ts`
  - `packages/server/src/adapters/claude-code/claude-code-host.ts`
