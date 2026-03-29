<!-- tags: bug, tool-status, history-restore -->
# Known Bugs

## 2026-03-29 — 세션 히스토리 복원 시 도구 상태 "실행 중" 잔존

- **현상**: 세션 히스토리를 복원(LOAD_HISTORY)하면 일부 도구 호출 블록이 "실행 중" 상태로 표시됨. 실제로는 완료된 도구임.
- **원인 추정**: restoreSession에서 로드한 HistoryMessage의 toolCalls에 result 필드가 있지만, resolveToolCall이 호출되지 않아 ToolCard의 resolveStatus()가 'running'을 반환.
- **영향**: UI 표시 문제만. 기능 동작에는 영향 없음.
- **재현**: 워크스페이스 선택 → 이전 세션 대화 표시 시 도구 블록 확인.
- **관련 파일**: session-store.ts (restoreSession), ToolRenderer.tsx (resolveStatus)