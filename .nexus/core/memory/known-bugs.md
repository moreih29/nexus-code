<!-- tags: bug, resolved, streaming -->
# Known Bugs

## 해결됨

### 2026-03-29 — 세션 히스토리 복원 시 도구 상태 "실행 중" 잔존
- **현상**: LOAD_HISTORY 후 도구 블록이 "실행 중" 표시
- **원인**: restoreSession에서 toolCalls의 result 미매칭
- **해결**: Phase 7에서 수정. result === undefined인 toolCall에 빈 문자열 할당
- **해결일**: 2026-03-29

### 2026-03-30 — SessionStoreContext null crash
- **현상**: 앱 시작 시 useActiveSession이 throw → Rendering Error
- **원인**: Store Factory 리팩토링 후 activeWorkspace=null일 때 store=null → throw
- **해결**: _emptyStore fallback 도입. store ?? _emptyStore로 null-safe 처리
- **해결일**: 2026-03-30

### 2026-03-30 — SessionStoreProvider children 미렌더 (빈 화면)
- **현상**: {store ? children : null} 적용 후 앱 시작 시 완전히 빈 화면
- **원인**: Sidebar(워크스페이스 목록)도 children에 포함되어 워크스페이스 선택 불가 → 데드락
- **해결**: {store ? children : null} → {children} 복원 + _emptyStore fallback으로 해결
- **해결일**: 2026-03-30

### 2026-03-30 — 스트리밍 미작동 (전체 텍스트 한 번에 표시)
- **현상**: 대화 응답이 스트리밍되지 않고 전체 결과가 한 번에 나옴
- **원인**: run-manager.ts에서 --include-partial-messages 플래그 누락 (커밋 6441d13에서 제거됨)
- **해결**: --include-partial-messages 플래그 복원. StreamParser의 기존 stream_event 처리 코드가 정상 동작
- **해결일**: 2026-03-30

### 2026-03-30 — React hooks 순서 위반 (streaming-message.tsx)
- **현상**: 워크스페이스 선택 시 React rendering error
- **원인**: useMemo가 early return 뒤에서 조건부 호출 → hooks 규칙 위반
- **해결**: useMemo를 early return 위로 이동
- **해결일**: 2026-03-30

## 진행 중

### 2026-03-30 — 스트리밍 UX 청크 단위 표시
- **현상**: 스트리밍은 작동하지만 청크 단위로 뚝뚝 끊겨 보임
- **원인**: CLI가 ~400-500ms 간격으로 청크 전달 (모델 토큰 생성 속도에 의존) + 드레인 소비 속도가 빨라 대기 시간이 김
- **현재 상태**: 적응형 charsPerFrame 튜닝 적용 (소비 속도 감소로 분산), 추가 확인 필요
- **관련 파일**: streaming-message.tsx (charsPerFrame), session-store.ts (appendTextChunk rAF)