<!-- tags: bug, resolved, streaming, security, memory-leak -->
# Known Bugs

## 해결됨

### 2026-03-29 — 세션 히스토리 복원 시 도구 상태 "실행 중" 잔존
- **현상**: LOAD_HISTORY 후 도구 블록이 "실행 중" 표시
- **원인**: restoreSession에서 toolCalls의 result 미매칭
- **해결**: Phase 7에서 수정. result === undefined인 toolCall에 빈 문자열 할당

### 2026-03-30 — SessionStoreContext null crash
- **현상**: 앱 시작 시 useActiveSession이 throw → Rendering Error
- **원인**: Store Factory 리팩토링 후 activeWorkspace=null일 때 store=null → throw
- **해결**: _emptyStore fallback 도입

### 2026-03-30 — 스트리밍 미작동
- **현상**: 대화 응답이 스트리밍되지 않고 전체 결과가 한 번에 나옴
- **원인**: --include-partial-messages 플래그 누락
- **해결**: 플래그 복원

### 2026-03-30 — process.cwd() 로그 경로 (코드리뷰 H-2)
- **현상**: 프로덕션 .app 번들에서 EACCES 오류로 로깅 실패
- **원인**: logger.ts, cli-raw-logger.ts에서 process.cwd() 의존
- **해결**: app.getPath('logs') 기반으로 전환

### 2026-03-30 — ipc:read-file 경로 미검증 (코드리뷰 H-1)
- **현상**: 임의 파일 읽기 가능한 보안 취약점
- **원인**: handlers.ts에서 경로 검증 없이 readFile 호출
- **해결**: 워크스페이스 범위 제한 + .md 확장자 필터 + IpcChannel 등록

### 2026-03-30 — AgentTracker 메모리 누수 (코드리뷰 H-4)
- **현상**: events 배열 무한 증가, clearSession 미호출
- **원인**: session_end 이벤트와 AgentTracker 정리 미연결
- **해결**: session_end에 clearSession 연결 + input 10KB 크기 제한

### 2026-03-30 — sandbox:false 보안 약화 (코드리뷰 D-2)
- **현상**: Electron 보안 모범사례 위배
- **해결**: sandbox:true 전환 (electron-log v5.4.3 sandbox 호환 확인)

## 진행 중

### 2026-03-30 — 스트리밍 UX 청크 단위 표시
- **현상**: 스트리밍은 작동하지만 청크 단위로 뚝뚝 끊겨 보임
- **원인**: 이중 rAF 경쟁 (store rAF + StreamingMessage rAF)
- **현재 상태**: T8 진단 로그 추가 완료, T9(rAF 수정)는 다음 사이클
- **관련 파일**: streaming-message.tsx, session-store.ts