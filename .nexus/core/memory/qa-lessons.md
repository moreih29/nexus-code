<!-- tags: qa, context, null-guard, cold-start, hooks, streaming, lessons-learned -->
# QA 교훈

## 2026-03-30 — Context null 전파 crash

### 사건
Store Factory 리팩토링 후 QA 7/7 PASS 판정했으나, 실제 실행 시 즉시 crash.
`SessionStoreProvider`가 `activeWorkspace=null`일 때 `store=null`을 Context에 주입 → `useActiveSession`이 throw.

### QA가 놓친 것
1. **Context null 전파 경로 미검증** — Provider의 value 타입에 `null` 포함 시, 소비하는 모든 컴포넌트가 null 상태에서 안전한지 렌더 트리 경로를 따라 확인해야 함
2. **Cold-start 시나리오 누락** — `activeWorkspace=null`은 앱의 정상 초기 상태. 초기 상태에서의 렌더 결과를 반드시 검증해야 함
3. **null→throw 패턴 식별 실패** — hook이 null을 throw로 변환하면, 호출부가 렌더 조건을 갖춰야 한다는 암묵적 계약. 이 계약을 정적으로 확인하지 않음

## 2026-03-30 — React hooks 순서 위반

### 사건
아키텍트 스펙에서 `useMemo`를 early return 뒤에 배치 → QA가 코드 검증 시 hooks 규칙 위반을 발견하지 못함 → 워크스페이스 선택 시 crash.

### QA가 놓친 것
- React hooks 규칙: 모든 hooks는 조건부 분기/early return 위에서 호출해야 함
- early return 전후의 hooks 호출 순서를 명시적으로 확인하는 체크 항목 필요

## 2026-03-30 — 스트리밍 원인 오진

### 사건
아키텍트가 "CLI stdout 블록 버퍼링"을 1차 원인으로 진단했으나, 실제 원인은 `--include-partial-messages` 플래그 누락. 리서처가 CLI 공식 문서 조사로 정확한 원인 발견.

### 교훈
- 리팩토링 전후 비교 시 "이전에 됐는데 지금 안 되면" 변경된 부분이 원인
- 외부 도구(CLI)의 동작을 추정하지 말고 공식 문서/git 이력으로 확인
- 아키텍트 분석이 부족하면 리서처에게 외부 조사를 병렬로 시켜야 함

## 향후 QA 체크리스트

- [ ] Context Provider의 value에 null이 가능한가? → 소비자 컴포넌트의 null-guard 확인
- [ ] 앱 초기 상태(cold-start)에서 주요 컴포넌트가 crash 없이 렌더되는가?
- [ ] Provider → Consumer 렌더 트리 전체 경로 추적 (개별 파일 검증만으로는 부족)
- [ ] null→throw 패턴이 있으면, 해당 hook을 호출하는 컴포넌트가 반드시 조건부 렌더 안에 있는지 확인
- [ ] early return 전후 hooks 호출 순서 확인 (React Rules of Hooks)
- [ ] 리팩토링 전에 작동하던 기능이 안 되면 git diff로 변경 지점 추적
- [ ] 구현 완료 후 `bun run dev`로 실행하고 Playwright MCP 또는 직접 스크린샷으로 화면 렌더링 확인