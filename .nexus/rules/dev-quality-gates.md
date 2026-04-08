<!-- tags: dev, quality, process, testing -->
# 개발 품질 게이트

코드 변경 시 반드시 준수할 규칙.

## 1. 검증

- typecheck 통과만으로는 불충분
- UI 변경 시 `bun run dev`로 실제 동작 확인 필수
- 비동기 흐름 변경 시 실제 시나리오로 수동 테스트

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

## 5. 완료 기준

- "완료" 선언 전 acceptance criteria를 각각 확인
- grep/wc로 정량 검증 (예: "중복 0건" 확인)
- 에이전트 작업 결과는 Lead가 반드시 검증 후 승인
