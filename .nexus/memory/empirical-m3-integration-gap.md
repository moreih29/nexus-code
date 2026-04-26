# M3 통합 누락 보완 사이클 회고

> 관찰 시점: 2026-04-25. 이 문서는 plan #15 closed 이후 dev launch 실측에서 발견된 두 건의 critical 결함과, 이를 보완한 plan #16 hotfix 사이클의 학습을 기록한다.

---

## 1. 발생 맥락

plan #15는 codegen 파이프라인, drift gate, facade, sidecar lifecycle handshake server, SidecarBridge 등 M3 핵심 인프라를 구축하고 단위·통합 테스트를 통과한 채 closed되었다. 그러나 사이클 종료 직후 수행된 dev launch 실측에서 두 건의 critical 에러가 발견되었다.

- **에러 1 — SidecarBridge 연결 누락**: plan #15 T6에서 신설한 SidecarBridge가 `electron-app-composition`의 서비스 그래프에 연결되지 않은 채 dev launch가 진행되었다. 이로 인해 SidecarLifecycleManager가 SidecarRuntime(이전 구현체) 대신 SidecarBridge를 주입받지 못하고, sidecar 프로세스에 NEXUS_SIDECAR_TOKEN 환경변수가 주입되지 않아 fatal exit 78이 발생했다.
- **에러 2 — ajv-cli standalone CJS 호환성 실패**: plan #15에서 도입한 `ajv-cli` 기반 standalone validate 코드(`generated/*.validate.ts`)가 bun runtime의 CJS polyfill로는 통과했으나, electron-vite의 ESM 프로덕션 빌드에서 `require is not defined`로 실패했다.

두 에러는 모두 "단위·통합 테스트 PASS"라는 cut line 안에서는 발견되지 않았다. 이 사이클은 이 누락의 원인과 교훈을 일반화한다.

---

## 2. 핵심 학습

### 1. 신설 모듈 연결 누락

통합 테스트는 SidecarBridge.start()를 직접 호출하는 모듈 단독 검증만 수행했다. 실제 dev launch 경로인 `composeElectronAppServices` → `SidecarLifecycleManager` → `SidecarRuntime` 객체 그래프에서는 SidecarBridge가 한 번도 인스턴스화되지 않았다. 신설 모듈이 기존 composition 함수에 import·등록되지 않으면, 해당 모듈의 단위·통합 테스트가 모두 PASS하더라도 최종 사용자 경로는 여전히 동작하지 않는다.

### 2. CJS/ESM 호환성: 런타임 불일치

ajv-cli는 schema를 미리 컴파일해 standalone CJS 모듈로 출력한다. 이 파일은 Bun 런타임의 CJS polyfill 환경에서는 정상 로드되었다(단위 테스트 통과). 그러나 electron-vite는 ESM-only 프로덕션 번들을 생성하며, 이 환경에서 미리 생성된 CJS standalone 파일의 `require()` 호출은 런타임 에러를 유발했다. "개발 런타임에서 통과"가 "프로덕션 빌드에서 통과"를 보장하지 않는다.

### 3. cut line 정의의 한계

plan #15의 cut line은 "단위·통합 테스트 PASS"로 정의되었다. 이 기준은 모듈 단위의 기능적 정확성은 검증하지만, 모듈 간 연결과 빌드 산출물의 실제 런타임 호환성은 검증하지 않는다. cut line이 실제 최종 사용자 경로를 포함하지 않으면, 사이클 종료 후에야 치명적 결함이 드러난다.

### 4. composition 경로 검증 가치

모듈을 직접 호출하는 통합 테스트가 아닌, 실제 객체 그래프를 인스턴스화하는 통합 테스트(`composition-smoke.test.ts`)를 추가하자 연결 누락이 즉시 발견되었다. composition 경로를 검증하는 테스트 1건은 수십 개의 모듈 단독 테스트를 대체하지 않지만, 연결 누락이라는 특정 클래스의 결함을 조기에 차단한다.

### 5. 빌드 산출물 검증의 가치

H1 해소 후 dist 출력물을 점검하자, `generated/*.validate.ts` 산출물에 남아 있던 `require` 패턴이 추가로 발견되었다. 빌드 완료 후 `dist/` 내 CJS require 패턴을 검증하는 절차를 cut line에 추가하면, ESM/CJS 호환성 누락을 배포 전이 아닌 빌드 직후에 조기 발견할 수 있다.

---

## 3. 향후 적용

plan #16의 학습을 이후 사이클 cut line에 다음 세 항목을 추가할 것을 권장한다.

1. **실제 dev launch 수동 검증 1회**: 사이클 종료 전, 실제 `bun run dev` 경로를 1회 이상 수동으로 실행해 최종 사용자 경로의 기본 동작을 확인한다.
2. **composition 경로 자동 통합 테스트 1건**: `composeElectronAppServices` 등 실제 객체 그래프를 인스턴스화하는 smoke 테스트를 유지하며, 신설 모듈이 composition에 연결되었는지 자동 검증한다.
3. **빌드 산출물 require 패턴 검증**: `electron-vite build` 완료 후 `dist/`에서 CJS `require` 패턴을 검색하여 ESM-only 환경에서의 호환성 결함을 조기에 차단한다.

---

## 4. 사이클 산출물 요약

plan #16은 세 건의 hotfix 태스크로 구성됐다.

- **H1 (validate ESM)**: facade에서 Ajv 런타임 컴파일로 전환. `generated/*.validate.ts` 삭제, `scripts/gen-contracts.ts`에서 ajv-cli 호출 제거, `package.json`에서 `ajv-cli` devDeps 제거.
- **H2 (SidecarBridge 교체)**: `SidecarBridge`로 교체하고 missing-binary fallback adapter를 추가(pid -1 unavailable event). `sidecar-bin-resolver.ts` 분리. `SidecarProcessRuntime`은 deprecated 처리.
- **H3 (integration verify)**: `composition-smoke.test.ts` 신설. 105 tests PASS. dev launch 수동 검증 1회 통과(시점 의존 검증 결과는 사이클 단편으로만 기록하고 영구 보관하지 않는다).

---

> 출처: plan #16 archive(H1~H3), `.nexus/memory/empirical-m3-handover-retrospective.md`, `.nexus/memory/pattern-sidecar-lifecycle-handshake.md`, `packages/app/composition-smoke.test.ts`
