# pattern: 테스트 설계 의사결정 지침

> 목적: 새 테스트를 작성하기 전에 "무엇을·어느 레벨로·어떻게 격리해" 결정하는 순서를 고정한다.
> 적용 범위: `tests/**` 전체 (unit · integration). 신규 테스트 작성 시 항상 이 문서를 먼저 읽는다.
> 연계(역할 분담):
> - **이 문서** — 설계 결정 순서 (무엇을·레벨·격리·보증)
> - `pattern-test-quality.md` — 이미 존재하는 테스트의 질 판별 잣대 (5속성 / AP 1–7 / D 규칙)
> - `pattern-bun-mock-conventions.md` — mock 작성 기법 (DI-first / leaf-only / spread-real-exports)
> - `conventions.md` "테스트 룰" — 중복 금지 원칙 (라이브러리 보장분 재검증 금지 · 상위시나리오 부분집합 금지)

겹치는 내용은 재서술하지 않고 위 문서를 참조 링크로 연결한다.

---

## 1. 무엇을 테스트할지

### 포함: 검증 대상

- **관측 가능한 동작** — 공개 API의 반환값 · 부수효과 · 상태 전이
- **계약** — 입력 도메인 경계, 전제조건 위반 시 예외
- **의미 있는 분기** — 조건 분기 각 경로 (if/switch 각 arm)
- **엣지케이스** — 빈 컬렉션 · 최솟값/최댓값 · null/undefined 경계
- **버그 회귀** — 수정된 버그마다 재현 케이스 1개

### 제외: 검증하지 않는 것

- **라이브러리·타입·스키마가 보장하는 동작** — zod 파싱 자체, TypeScript 타입 재진술, mock 인자 echo류 (→ `conventions.md` "테스트 룰" 참조)
- **상위 시나리오의 부분집합** — 이미 통합 테스트가 커버하는 경로를 단위 테스트로 중복 작성 금지 (→ `conventions.md` "테스트 룰" 참조)
- **trivial getter/단순 위임** — 구현을 그대로 복사하는 단언은 보증이 없다 (→ `pattern-test-quality.md` AP-1 참조). "테스트가 소프트웨어 실제 사용 방식과 닮을수록 신뢰가 커진다" — Testing Library Guiding Principles (https://testing-library.com/docs/guiding-principles/)
- **내부 상태·private 메서드** — 직접 검증 시 거짓 음성(리팩터링에 깨짐) + 거짓 양성(망가져도 통과) 발생 — Kent C. Dodds "Testing Implementation Details" (https://kentcdodds.com/blog/testing-implementation-details)

### 입력 나열형은 `test.each` 표 1개로

동일 SUT에 대해 입력값만 다른 케이스는 `test.each` 표 1개로 통합한다. 각 행에 의미 있는 DAMP 라벨을 붙여 실패 시 어느 케이스인지 즉시 알 수 있게 한다. 개별 `test`를 나열하면 AP-6 (거대 테스트) 없이도 중복이 쌓인다.

---

## 2. 어느 레벨로 작성할지

Google Test Sizes 분류를 기준으로 삼는다. "small test는 sleep/network/DB/filesystem IO 금지(hermetic)" — Google Testing Blog "Test Sizes" (https://testing.googleblog.com/2010/12/test-sizes.html)

### Small (단위) — hermetic

- **조건**: 외부 I/O 없음 · sleep 없음 · 실제 네트워크 없음 · 실제 파일시스템 없음
- **실시간 타이머 대신** `bun:test`의 가짜 타이머(`useFakeTimers`) 사용
- **실제 I/O 대신** `*Deps` 주입 (→ `pattern-bun-mock-conventions.md` Rule 1/3)
- 적합한 대상: 순수 함수 · 상태 머신 · 도메인 로직 · IPC 핸들러 단위

### Integration — 실 I/O 허용

- 실제 파일시스템 · 프로세스 간 통신이 필요할 때
- 단위 레벨로 충분히 검증한 경로를 integration에서 중복하지 않는다
- 상위 시나리오가 이미 커버하면 추가하지 않는다 (→ `conventions.md` 참조)

### 렌더러 컴포넌트의 레벨 선택

- **순수 로직** (상태 계산, 파생값): 격리 단위 테스트로 충분
- **UI 동작** (이벤트 처리, 렌더 결과, 접근성): `render()`를 사용해 실제 사용 방식과 가까운 테스트를 작성한다 — Testing Library Guiding Principles (https://testing-library.com/docs/guiding-principles/)
- **렌더러 전체를 우회하는 subcutaneous 접근**은 이 프로젝트 방침상 "UI 밖으로 순수 로직을 분리한 경우에만" 허용한다. Subcutaneous 테스트 개념 자체는 Martin Fowler "SubcutaneousTest" (https://martinfowler.com/bliki/SubcutaneousTest.html) 참조.

---

## 3. 어떻게 격리할지

"각 테스트는 실행 순서에 무관하게 동일한 결과를 내야 한다(Isolated) · 1개든 N개든 동일해야 한다(Composable)" — Kent Beck "Test Desiderata" (https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3)

"전역 상태 누수 → 단독 통과·전체 실패; 각 테스트는 자체 setup/teardown을 소유해야 한다" — Google Testing Blog "Flaky Tests" (https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)

### Electron 공유 모듈 — canonical hermetic stub 의존

`bun:test`의 `mock.module`은 process-global이다. `electron` 같이 여러 테스트 파일이 공유하는 모듈을 파일별로 부분 mock하면 순서 의존 오염이 발생한다(예: 한 파일에서 `webContents`만 정의하고 `ipcMain` 누락 → 다음 파일에서 `ipcMain`이 없는 전역 상태를 이어받음).

**규칙**: Electron 등 공유 모듈은 `tests/setup.ts`의 **canonical hermetic stub**에 의존한다. 이 stub은 전역 preload 단계에서 설치되고, 모든 참조 surface(`ipcMain` · `ipcRenderer` · `webContents` · `app` · `BrowserWindow` 등)를 갖춘 단일 정의다. 파일별 부분 electron mock 신규 작성은 금지한다.

→ `pattern-bun-mock-conventions.md` Rule 5 참조

### 추가 mock은 파일 경계 내 복원

파일이 `setup.ts` stub 위에 추가로 설치한 mock이나 spy는 반드시 `afterEach(() => mock.restore())` 로 파일 경계 안에서 되돌린다. `afterAll`은 파일 내 모든 테스트가 끝난 뒤 전역을 오염시킬 수 있으므로 추가 mock 복원에는 사용하지 않는다.

### 내부 의존성 — DI seam 우선

프로젝트 내부 모듈 의존성은 `mock.module`보다 `*Deps` / `default*Deps` seam을 먼저 검토한다.

→ `pattern-bun-mock-conventions.md` Rule 1/3 참조

---

## 4. 무엇으로 보증할지

### 행위 검증

- **검증 대상**: 관측 가능한 출력 · 상태 · 부수효과
- **금지**: 구현 로직을 단언으로 복사 (AP-1), 목 호출 순서만 검증하고 결과 단언 없음 (AP-2)
- "구조 변경에 둔감해야 한다(Structure-insensitive)" — Kent Beck "Test Desiderata" (https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3)

→ `pattern-test-quality.md` A 5대 속성 / AP-1 / AP-2 참조

### 커버리지는 수단, 숫자는 목표가 아님

높은 커버리지 숫자 자체가 품질을 보장하지 않는다 — Martin Fowler "TestCoverage" (https://martinfowler.com/bliki/TestCoverage.html). 커버리지는 미검증 경로를 발견하는 신호로 쓰되, 수치 달성을 위한 의미 없는 테스트를 추가하지 않는다.

### 게이트 절차 — `scripts/test-gate.sh`

새 테스트를 추가·변환한 뒤 반드시 아래 4단계를 통과시킨다.

| 단계 | 검증 내용 |
|------|-----------|
| full | 전체 스위트 0 fail / 0 error |
| solo == full | 변경 파일 단독 실행 결과 = 전체 실행 결과 (격리 확인) |
| shuffle | 무작위 실행 순서에서도 동일 결과 (순서 의존 없음 확인) |
| coverage superset | 변환 전 커버리지를 포함하거나 초과 (무손실 변환 확인) |

**무손실 변환 보증**: `expect` 호출 카운트 보존 + coverage superset.

**구현결합 테스트 재작성 보증**: mutation spot-check — SUT에 의도적 버그를 주입한 뒤 재작성한 테스트가 red가 되는지 확인한다. red가 되지 않으면 보증성 없음(→ `pattern-test-quality.md` A 보증성 / AP-1 참조).

---

## 5. 신규 테스트 작성 체크리스트

작성 전:
- [ ] 관측 가능한 동작·계약·분기·엣지·회귀 중 어느 것인가?
- [ ] 라이브러리·타입·스키마가 보장하는 동작을 재검증하려는 것은 아닌가?
- [ ] 상위 시나리오 테스트가 이미 커버하는 부분집합은 아닌가?
- [ ] 입력 나열형이면 `test.each` 표로 통합할 수 있는가?

레벨 결정:
- [ ] Small(hermetic) 조건을 충족하는가? 충족하지 못하면 integration으로 분류한다.
- [ ] 렌더러 로직이면 순수 로직 / UI 동작 중 어느 쪽인가?

격리:
- [ ] Electron 등 공유 모듈은 `tests/setup.ts` canonical stub에 의존하는가?
- [ ] 추가 mock은 `afterEach(() => mock.restore())`로 복원하는가?
- [ ] 내부 의존성은 `*Deps` seam으로 처리했는가?

보증:
- [ ] 단언이 관측 가능한 출력·상태를 검증하는가? (구현 복사 아닌가?)
- [ ] `scripts/test-gate.sh` 4단계(full / solo / shuffle / coverage)를 통과하는가?
- [ ] 구현결합 재작성이면 mutation spot-check를 수행했는가?
