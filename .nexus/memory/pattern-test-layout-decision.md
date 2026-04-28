# 테스트 배치 전략 결정 패턴

## 적용 시점

테스트 파일과 로직 파일의 배치 정책을 결정·재검토할 때 사용한다. 신규 패키지 추가, 모노레포 통합, 빌드 도구 교체 등으로 기존 정책을 재평가하는 시점이 전형적이다.

## 판단 축 4개

배치 옵션을 비교할 때 다음 4축을 모두 채워야 결론이 견고해진다. 한 축만 보고 결정하면 다른 축이 깨진다.

### 1. 빌드·번들 위생

- 산출물(`dist/`, `out/`, `*.asar`)에 테스트가 누설되는가?
- typecheck 입력에 테스트가 포함되어 있는가?
- 누설을 막는 가장 단순한 mechanism은 무엇인가? (entry-point 빌드 / glob exclude / 디렉터리 분리)

본 프로젝트(electron-vite)는 entry-point 기반 빌드라 산출물 누설은 자동 차단. typecheck만 위생 갭이었고, tsconfig exclude 한 줄로 해소.

### 2. import 깊이와 안정성

- 테스트가 source를 import할 때 상대경로가 몇 단계 깊어지는가?
- path alias가 도입돼 있는가? 위치 변경이 alias 효용을 늘리는가/줄이는가?
- fixture·mock의 위치 변경 비용은?

옆 배치(`*.test.ts`) → +0단계, `__tests__/` → +1단계, `test/<mirror>` → +2~3단계. alias 미도입 상태에서는 깊이 증가가 직접적 비용.

### 3. 트렌드·관용 정합

- 같은 언어·도구 생태계의 다수파 패턴은 무엇인가?
- 단일 트렌드인가, 양분되어 있는가? (양분이면 트렌드는 결정 근거가 못 된다)
- 프로젝트의 성격(라이브러리 / 모노레포 / 앱)이 어느 패턴 다수파에 속하는가?

⚠️ **함정**: "co-location이 모던 트렌드"라는 통념을 검증 없이 받아들이지 마라. plan #28에서 GitHub 15개 직접 확인 결과 C(test/ 루트)와 D(하이브리드)가 양대 다수파였고, 단일 대세는 없었다. 자세한 데이터는 `external-typescript-test-layouts.md`.

### 4. 마이그레이션 비용

- 이동할 파일 수와 import 재작성 범위는?
- 자동화 가능성(`git mv` + sed)은?
- review와 blame 추적이 보존되는가?

일회성 작업의 절대 비용보다 review 가능성과 회귀 위험이 더 중요하다. 70개 파일 mv는 자동화가 쉽지만 import 재작성은 alias 도입 없이는 누락 발생 가능.

## 결정 알고리즘

1. 빌드·번들 위생 갭이 있는가?
   - 있으면: 빌드 도구의 entry-point/exclude 매커니즘으로 먼저 봉합 가능한지 확인.
   - 봉합 가능하면: **위치 변경 없는 정책 + 위생 패치**로 마무리 (현 상태 유지가 정답일 가능성 높음).
2. 봉합 불가하거나 위생 외 동기(가독성·트렌드)가 강하면:
   - 트렌드를 검증한다(직접 데이터 수집). 단일 대세가 없으면 트렌드는 결정 축에서 제외.
   - import 깊이와 마이그레이션 비용으로 현실적 옵션 좁히기.
   - 이미 부분 적용된 패턴이 있으면(예: 기존 `test/integration`) 같은 방향으로 통합하는 것이 정합 비용 최저.
3. 결정 후 conventions에 명문화한다. 언어별로 관용이 다르면(TS vs Go) 분기해서 기록한다.

## 함정 — Lead 권고의 과보정

plan #28에서 Lead는 권고를 두 차례 뒤집었다.

1. 1차: `__tests__/` 옆 폴더 (L4 하이브리드) — Jest 관용에 의존한 일반론 추정
2. 2차: `test/<mirror>` 완전 분리 — user의 "분리" 명제에 과도하게 맞춤
3. 3차: 현행 co-location 유지 — researcher 데이터로 트렌드 양분 확인 후 정착

교훈:
- 사용자 명제("분리하고 싶다")의 표면 의미를 따르기 전에, 그 명제가 어느 갈래에 속하는지 데이터로 확인하라.
- "트렌드"라고 단언하기 전에 직접 저장소를 확인하라(general knowledge로 단언 금지).
- 권고를 뒤집을 때마다 user의 신뢰가 줄어든다. **첫 권고 전에 researcher를 돌려야 했다.**

향후 유사 결정에서는 다음 순서를 따른다.

1. 먼저 explore로 현재 상태 파악
2. 그 다음 researcher로 외부 사례 수집(트렌드 검증)
3. 그 후에야 architect 분석 + Lead 권고

researcher 단계를 건너뛰고 architect로 직행하면 권고가 일반론에 의존해 뒤집힐 위험이 커진다.

## 함정 — plan-issue-title을 디렉터리 이름으로 빌리기

plan issue나 task 제목을 리포지토리의 디렉터리 이름으로 그대로 옮기지 마라. 계획 문맥의 제목은 "이번 사이클에서 무엇을 결정했는가"를 찾기 위한 표지다. `M6 통합 안정성 검증 게이트 갱신` 같은 이름은 계획 안에서는 충분히 선명하지만, 코드 트리에 들어오면 `m6-stability/`처럼 릴리스·마일스톤 라벨이 영구 구조로 굳는다. 시간이 지나면 그 디렉터리는 무엇을 테스트하는지가 아니라 언제 생겼는지만 말한다.

발견 경로: plan #29 T13에서 `packages/app/test/m6-stability/`가 task에 명시됐다. plan #30 fix 슬라이스에서 사용자가 `m6-*` 계열 이름의 의미가 모호하다고 지적했고, 결과적으로 테스트는 `integration/` 아래 의미별 파일로 분할 흡수됐다.

따라서 task를 작성할 때는 먼저 제목에서 마일스톤·이슈 라벨을 걷어내고, 남는 테스트 대상과 경계만 이름 후보로 삼는다. 안정성 검증이라도 LSP 장기 안정성, layout mount, CJK regression, keybinding처럼 실제 테스트 축이 다르면 하나의 마일스톤 폴더로 묶지 말고 `integration/` 아래 파일명으로 나눈다. 릴리스가 지나도 이름이 설명력을 유지하는지가 최종 점검 기준이다.

규칙:
- plan issue/task 제목은 planning decision(계획상의 결정 단위)을 식별하는 이름이다.
- 리포지토리 디렉터리 이름은 "무엇을 테스트하는가"에 기반한 영구 의미 카테고리여야 한다.
- 마일스톤 라벨을 디렉터리 이름으로 빌리지 말고, 필요하면 `integration/`, `system/`, `packaging/`처럼 테스트 성격으로 다시 이름 붙여라.

## 본 프로젝트의 결정 (예시)

| 언어 | 정책 |
|---|---|
| TypeScript | 소스 옆 `*.test.ts(x)` co-location, `__tests__/` 미사용. integration·system·packaging은 `packages/<pkg>/test/<category>/` 분리. tsconfig exclude로 typecheck 입력에서 분리. |
| Go | `*_test.go` 같은 디렉터리·같은 패키지. 외부 시점은 `package <name>_test` 허용. `tests/` 분리 금지. |

근거: `.nexus/context/conventions.md` "테스트 배치" 섹션 + plan #28 결정 기록.

## 갱신 트리거

- 빌드 도구가 electron-vite에서 다른 도구로 바뀔 때 (entry-point 가정 무효)
- vitest·jest 도입 검토 시 (위치 발견 패턴 차이 확인)
- TypeScript path alias 도입 시 (import 깊이 축이 무효화되어 다른 옵션 재평가 가능)
- 외부 트렌드 분포가 크게 변할 때 (`external-typescript-test-layouts.md` 갱신과 연동)
