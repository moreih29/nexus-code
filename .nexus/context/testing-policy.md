# Testing Policy

이 문서는 회귀 가드와 테스트 책임 경계를 정의한다. 테스트 파일의 물리적 배치 규칙은 `.nexus/context/conventions.md`의 "테스트 배치" 섹션을 따른다.

## 회귀 가드 정책

다음 세 정책은 PR 단위로 적용한다.

1. **layout-critical 또는 service-boundary 변경은 system smoke fixture와 함께 들어간다.**
   - layout-critical 변경은 워크벤치 레이아웃, dock/split 동작, panel mount 안정성, workspace 전환 시 레이아웃 복원처럼 사용자 화면 구조나 mount 생명주기를 바꾸는 변경을 뜻한다.
   - service-boundary 변경은 service interface, service 구현 책임, component → service 의존 경계를 바꾸는 변경을 뜻한다.
   - 해당 변경을 도입하는 PR은 같은 PR 안에서 `packages/app/test/system/`의 system smoke fixture를 추가하거나 기존 fixture를 갱신해야 한다.
2. **service interface 변경은 contract test를 함께 갱신한다.**
   - interface의 method, 입력 타입, 반환 타입, 이벤트 계약, error/empty-state 의미가 바뀌면 관련 contract test를 같은 PR에서 갱신한다.
   - TypeScript type-level 확인만으로 사용자 경로의 계약 안정성이 보장되지 않으면 runtime sanity test도 추가한다.
3. **모든 service는 method-level unit test coverage 100%를 유지한다.**
   - 기준은 public method 단위다. 각 service의 모든 public method가 최소 1개 이상의 unit test에서 직접 검증되어야 한다.
   - branch coverage 100%는 요구하지 않는다. 다만 error path나 boundary value가 service 계약의 일부라면 별도 test case로 둔다.

아키텍처 가드 규칙(예: shadcn forwardRef wrapper 금지, layout-critical library 책임)은 `design-architecture.md`를 참조한다.

## PR 체크

`.github/PULL_REQUEST_TEMPLATE.md`는 위 세 정책을 체크박스로 노출한다. 항목이 변경 범위에 해당하지 않으면 PR 작성자가 `N/A` 사유를 남긴다.

## CI system smoke enforcement

`.github/workflows/system-smoke.yml`는 push와 PR에서 `packages/app/test/system/`의 Electron renderer system smoke fixture 10종을 자동 실행한다. 이에 따라 layout-critical/service-boundary 변경의 system smoke 동반 정책은 CI에서 런타임 회귀 가드로 enforcement된다.

변경 파일과 fixture 파일의 정확한 매핑을 강제하는 file-diff check script는 아직 도입하지 않는다. 실제 리뷰 수요나 반복 누락 사례가 생기면 ESLint가 아니라 전용 check script/CI gate로 재평가한다.

## ESLint custom rule 결정

**결정: ESLint custom rule 도입은 보류한다.**

현재 저장소에서 확인한 ESLint 운용 패턴은 `packages/app/eslint.config.js`의 renderer 전용 `no-restricted-imports` 규칙이다. 이 규칙은 `src/renderer/**`에서 `node-pty` import를 금지하는 정적 import guard이며, PR diff와 system smoke fixture 동반 여부, contract test 갱신 여부, service method-level coverage 같은 PR 단위 정책을 낮은 노이즈로 판정하는 기존 custom rule 패턴은 없다.

따라서 PR 단위의 변경 파일/테스트 파일 매핑 판정은 ESLint custom rule로 만들지 않는다. 현재 enforcement는 system smoke workflow와 PR template으로 수행하며, file-diff check가 필요해지면 전용 check script로 재평가한다.
