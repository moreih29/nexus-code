# pattern-dev-launch-verification

스냅샷 날짜: 2026-04-26

cut line이 단위·통합 테스트 PASS에 머무를 때 실제 개발 실행 경로의 연결 누락을 막기 위한 dev launch 검증 패턴이다. `release-evidence/`를 다시 사용하지 않고 일시 결과와 영구 학습을 분리한다.

---

## 1. 적용 조건

다음 조건 중 하나라도 해당하면 사이클 종료 전 dev launch 검증을 cut line에 포함한다.

- 신설 모듈이 기존 composition, bootstrap, lifecycle, IPC, sidecar, renderer entry 경로에 연결된다.
- 테스트가 모듈을 직접 호출하지만 최종 사용자 경로의 객체 그래프를 그대로 인스턴스화하지 않는다.
- Bun, Electron, electron-vite, Node, 브라우저 런타임처럼 개발·빌드·실행 런타임이 둘 이상이다.
- 코드 생성물, 번들 산출물, 동적 import, ESM/CJS 경계, 환경변수 주입처럼 테스트 런타임과 실제 앱 런타임의 차이가 결함 원인이 될 수 있다.
- release cut, handover, hotfix 종료 판단을 남겨야 한다.

이 패턴은 전체 회귀 테스트를 대체하지 않는다. 목적은 dev launch 경로가 최소 1회 부팅되고, 새 코드가 사용자 진입 경로에 연결되었음을 확인하는 것이다.

---

## 2. 검증 절차

### 2.1 Prepare

- 검증 대상 cut line과 dev launch 명령을 명시한다. 기본 예시는 `bun run dev`이며, 별도 명령이 있으면 그 명령을 우선한다.
- 이번 변경이 통과해야 하는 사용자 경로를 한 문장으로 적는다. 예: 앱 compose → sidecar lifecycle → bridge start → renderer observable state.
- 기존 테스트 PASS만으로 확인되지 않는 연결 지점을 표시한다.
- 실행 전 known issue, 미적용 범위, 의도적 N/A가 있으면 먼저 기록한다.

### 2.2 Run

- 실제 개발 실행 명령을 clean terminal에서 1회 이상 실행한다.
- 앱을 사용자가 보는 방식으로 열고, 변경된 경로가 호출되는 최소 동작을 수행한다.
- launch 중 fatal exit, unhandled rejection, renderer blank screen, preload/import 실패, sidecar token·env 누락을 즉시 BLOCK으로 본다.
- 상주형이면 검증 완료 시점과 종료 방법을 명확히 한다.

### 2.3 Observe

- “프로세스가 떴다”만 PASS로 보지 않는다. 변경된 모듈이 실제 composition 경로에 연결되어 실행되었는지 관찰한다.
- 콘솔 로그, 앱 UI 상태, sidecar lifecycle event, dist/import 오류, runtime exception을 함께 확인한다.
- 테스트 런타임과 실제 런타임이 다를 경우 빌드 산출물 또는 런타임 로그에서 CJS `require`, missing env, missing binary fallback 같은 경계 오류를 추가로 확인한다.
- critical 오류가 있으면 cut line은 BLOCK이다.

### 2.4 Record

- 시점 의존 실행 결과, 로그, 스크린샷, 임시 verdict는 `nx_artifact_write`로 `.nexus/state/artifacts/` 아래에만 남긴다.
- `release-evidence/` 디렉터리는 영구 폐기되었으므로 새 파일을 만들거나 기존 경로를 증거 위치로 참조하지 않는다.
- 반복 가능한 교훈만 `.nexus/memory/`에 승격한다. 단순 PASS 로그와 일회성 실행 출력은 memory에 저장하지 않는다.
- 최종 보고에는 실행 명령, 관찰한 사용자 경로, PASS/BLOCK verdict, artifact 경로를 적는다.

---

## 3. 교훈 참조

`empirical-m3-integration-gap.md`는 단위·통합 테스트 PASS 이후 실제 dev launch에서 SidecarBridge 연결 누락과 ajv-cli standalone CJS 호환성 실패가 발견된 사례를 기록한다. 이 사례의 핵심 교훈은 “모듈 테스트 PASS는 composition 연결 PASS가 아니다”와 “개발 테스트 런타임 PASS는 Electron ESM 실행 PASS가 아니다”이다.

따라서 신설 모듈이 composition에 연결되거나 번들·런타임 경계가 바뀌는 사이클은 dev launch 1회를 cut line에 포함해야 한다. 이번 사이클 T14는 이 패턴을 적용한다.
