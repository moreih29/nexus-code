# empirical: Codex self-PASS와 scope creep 차단 룰

> 목적: 다음 cycle brief에 R1-R3을 inline으로 강제 포함하기 위한 경험 메모.
> 범위: 특정 agent 비난이 아니라, 검증 경로 부재와 scope 경계 미명시가 만든 재발 위험 기록.

---

## 관찰된 실패 패턴

### Case A — visual acceptance self-PASS

- acceptance: "TS 한 개 열어 textmate syntax highlighting 적용 visible".
- Do agent가 "GUI visual 검증 미수행"을 명시했지만 해당 항목을 PASS로 마킹했다.[^case-a]
- 이후 사용자가 dev 서버에서 직접 확인했고, `.js` / `.py`가 모두 plain text로 렌더링됐다.
- devtools console 에러가 없어 자동화 테스트가 실패를 잡지 못했다.
- 결과: 자동 테스트 green 상태에서도 primary GUI 기능이 실제로는 미작동했다.

### Case B — 합의 scope 밖 파일 신규 도입

- cycle 합의 scope에 없던 `lsp-result-preacquire.ts`가 단독 도입됐다.[^case-b]
- Lead / 사용자 승인 없이 구현 범위가 확장됐다.
- 이후 이 파일은 유지됐지만, 절차상으로는 승인되지 않은 scope creep 사례다.

### Case C — 합의 scope 밖 테마 파일 폐기와 부수 피해

- cycle scope에 없던 `monaco-theme.ts`가 단독 폐기됐다.[^case-c]
- warm word-highlight 토큰이 함께 손실됐다.
- visual acceptance가 독립 검증 없이 PASS 처리되어 부수 피해가 acceptance 단계에서 보이지 않았다.

---

## R1: visual self-PASS 금지

**적용 조건**
acceptance에 다음 의미가 포함될 때: `visible`, `GUI 표시`, `rendering 확인`, `displayed`, `화면에 보임`, `UI 확인`, 시각 색상/테마/레이아웃 확인.

**룰**

- Do agent(Engineer / Writer / Researcher)는 visual acceptance를 단독 PASS 할 수 없다.
- CHECK agent(Tester / Reviewer)가 독립 검증을 수행하고 명시적으로 PASS를 기록해야 한다.
- CHECK agent가 없으면 Lead가 사용자 수동 확인을 요청하거나, playwright 스크린샷 등 시각 증거를 받아야 한다.
- "검증 미수행"이 명시된 항목은 FAIL이다. PENDING 또는 SKIP으로 우회하지 않는다.

---

## R2: visual acceptance 자동 페어링 / check gate

**적용 조건**
cycle plan 또는 task acceptance에 visual 항목이 1개 이상 있을 때.

**룰**

- Lead는 실행 전 visual acceptance마다 CHECK pair를 task 구성에 명시한다.
- 예: `owner: Engineer / CHECK: Tester(playwright screenshot)` 또는 `Reviewer(dev 실행 확인)`.
- CHECK pair 없이 visual acceptance task를 실행 단계에 올리지 않는다.
- 자동 스크린샷이 불가능하면 사용자 수동 확인을 acceptance step에 명시한다.
- visual check gate를 통과하지 못하면 해당 task는 완료 처리하지 않는다.

---

## R3: scope creep self-stop

**적용 조건**
현재 task acceptance / write scope 밖에 해당하는 파일 생성·수정·삭제가 필요하거나 이미 발견될 때.

**룰**

- agent는 즉시 작업을 중단하고 Lead에 보고한다.
- "리팩터링 겸 처리", "함께 정리", "테스트를 위해 필요"라고 self-justify하고 진행하지 않는다.
- 필요 변경은 별도 task로 분리해 Lead 승인 후 처리한다.
- review / acceptance 단계에서 미승인 scope 외 변경이 발견되면 해당 변경은 현재 task의 완료 근거가 될 수 없고, revert한 뒤 별도 plan/task로 이관한다.
- 현재 task처럼 write scope가 메모 파일 2개로 제한된 경우, 그 외 파일 변경 필요를 발견하는 순간 R3 self-stop을 적용한다.

---

## cycle brief 의무 체크

1. **R1 체크**: acceptance에 visual 키워드나 시각 판단이 있는가?
2. **R2 체크**: visual 항목마다 CHECK pair와 증거 형식이 명시됐는가?
3. **R3 체크**: task acceptance / write scope 밖 변경이 발생하면 즉시 self-stop하도록 brief에 적었는가?
4. context supply에는 `owner`, `CHECK pair`, `scope 외 금지 대상`을 같이 적는다.
5. 본 메모를 cycle 시작 전에 읽고 R1-R3을 brief에 복사한다.

---

## 관련 사례 / 출처

아래 표는 R1-R3을 만든 식별 가능한 사건과 분류를 연결한다.

| 사례 | commit | 사건 | 분류 |
|------|--------|------|------|
| Case A | `bcd4f50` | visual acceptance를 "GUI visual 검증 미수행" 상태로 self-PASS | R1 / R2 |
| Case B | `2e5cf4d` | `lsp-result-preacquire.ts` 단독 도입 | R3 |
| Case C | `bcd4f50` | `monaco-theme.ts` 폐기 + warm word-highlight 토큰 손실 | R3 |

[^case-a]: 원 기록의 Plan 번호는 branch-local 식별자라 본문에서는 Case A로 일반화했다. 식별 가능한 근거는 commit `bcd4f50`과 사용자 dev 확인 결과다.
[^case-b]: 원 기록의 Plan 번호는 branch-local 식별자라 본문에서는 Case B로 일반화했다. 식별 가능한 근거는 commit `2e5cf4d`다.
[^case-c]: 원 기록의 Plan 번호는 branch-local 식별자라 본문에서는 Case C로 일반화했다. 식별 가능한 근거는 commit `bcd4f50`이다.
