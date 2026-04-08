<!-- tags: dev, quality, process, testing, db, sse, agent -->
# 개발 품질 게이트

코드 변경 시 반드시 준수할 규칙.

## 1. 검증

- typecheck 통과만으로는 불충분
- UI 변경 시 `bun run dev`로 실제 동작 확인 필수
- 비동기 흐름 변경 시 실제 시나리오로 수동 테스트
- **API 구현 후 반드시 왕복 테스트** — `curl -X PUT` → `curl GET`으로 저장→조회 확인. curl 한 번이면 잡히는 버그를 아키텍트 4명 투입 후에야 발견하지 말 것
- **Playwright 활용** — 설정 변경, 테마 전환 같은 UI 흐름은 Playwright로 실제 클릭→확인. 코드 리뷰만으로는 비동기 타이밍 문제를 잡을 수 없음

## 2. 커밋 단위

- 10개 파일 이상 변경 시 분할 커밋
- 각 단계마다 typecheck + 동작 확인
- 리팩토링과 버그 수정은 별도 커밋

## 3. 비동기 안전성

- 비동기 흐름(store action, API 호출) 변경 시 race condition 시나리오를 명시적으로 검토
- fire-and-forget 패턴(`void asyncFn()`) 사용 시 경합 조건 문서화
- optimistic update 시 반드시 실패 롤백 또는 서버 응답 확정 구현

## 4. 상태 관리 원칙

- 동일 데이터를 복수 필드에 복제하지 말 것
- 파생 가능한 값은 computed selector로 구현
- 수동 동기화(sync) 코드는 구조적 결함의 신호 — derived state로 전환

## 5. DB 안전성

- **SQLite UPSERT + NULL**: `UNIQUE(col_a, col_b)`에서 col_b가 NULL이면 `ON CONFLICT`가 발동하지 않음 (NULL != NULL). NULL 가능 컬럼의 UPSERT는 명시적 UPDATE-or-INSERT 패턴 사용
- DB 스키마 변경 후 반드시 왕복 테스트 (INSERT → SELECT로 저장/조회 확인)
- 설정 저장 같은 핵심 경로는 단위 테스트 필수

## 6. SSE/WebSocket 연결

- 서버 리소스(WorkspaceGroup 등)가 준비된 후에만 연결 시도 — "존재하면 연결"이 아니라 "활성 세션이 있으면 연결"
- 404/503에 대한 무한 재시도 금지 — 지수 백오프 적용 (2s → 4s → ... 최대 60s)
- 연결 성공 시 백오프 리셋

## 7. 완료 기준

- "완료" 선언 전 acceptance criteria를 각각 확인
- grep/wc로 정량 검증 (예: "중복 0건" 확인)
- 에이전트 작업 결과는 Lead가 반드시 검증 후 승인
- **근본 원인을 찾기 전에 수정하지 말 것** — 증상 치료를 반복하면 같은 버그가 다른 형태로 재발

## 8. 에이전트 운용

- 에이전트에게 조사 범위를 너무 넓게 주지 말 것 — 토큰 예산을 탐색에 소진하고 보고서를 못 씀
- "반드시 최종 보고서를 작성할 것"을 프롬프트에 명시
- 에이전트가 "수정 완료"라고 하면 Lead가 실제 동작을 확인할 때까지 완료로 간주하지 않음
