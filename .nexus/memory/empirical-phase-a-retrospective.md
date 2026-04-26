# Phase A Runnable Shell 회고

> 관찰 시점: 2026-04-24. 이 문서는 Phase A 게이트 수행 중 발견된 결함과 관찰 교훈을 기록한다.

---

## 1. 게이트 개요

- Run ID: `2026-04-24T15-12-00KST_task11`
- 브랜치: `feat/phase-a-runnable-shell`
- 판정: PASS (자동화 14:44–14:52 KST, 수동 검증 15:30 KST 종료)

자동화 게이트 7개와 수동 기준 8개를 모두 통과했다.

---

## 2. 발견 결함 및 수정

### xterm proposed API 오류

`allowProposedApi: true`를 `XtermView`에 강제 설정. 애드온 사용 시 proposed API 플래그를 명시해야 한다.

### Electron dev renderer 폰백 실패

`process.env.ELECTRON_RENDERER_URL`을 우선 사용하고 `start`가 preview 전에 빌드를 선행하도록 수정. 개발·프로덕션 경로 분기는 네이티브 smoke에서 양쪽을 검증해야 한다.

### 터미널 포커스·xterm CSS 누락

`@xterm/xterm/css/xterm.css`를 임포트하고 활성화·클릭 시 포커스를 이동. xterm.js는 CSS와 포커스 관리가 필수이며 렌더링만 되는 자동 게이트로는 부족하다.

### 터미널 cwd 불일치

메인 터미널 라우터가 `workspaceId`를 `WorkspacePersistenceStore.absolutePath`로 해석해 `cwd`를 주입. 워크스페이스와 터미널의 경로 매핑은 통합 게이트에서 확인해야 한다.

### 빠른 워크스페이스 전환 WebGL 손상

`XtermView.fit()`에서 WebGL texture atlas를 클리어하고 모든 행을 새로고침. `ShellTerminalTabs`는 `requestAnimationFrame` 복구를 예약. 사용자가 재현 불가를 확인. WebGL 기반 터미널은 가시성 전환 시 GPU 메모리 상태와 DOM 타이밍이 어긋날 수 있다.

---

## 3. 프로세스 라이프사이클 관찰

종료 시 sidecar·node-pty 프로세스 누락이 없음을 자동화 증거와 수동 확인으로 확보했다. 이는 Electron main 프로세스 종료 시 sidecar가 올바르게 정리된다는 운영 가정을 실증한다.

---

## 4. 교훈 — 결정 매핑

### 네이티브 렌더링 이슈는 자동 게이트로 커버되지 않는다 (Issue 6)

빠른 전환 렌더링 손상은 UI 타이밍·GPU 상태 의존으로 자동 테스트 재현이 어렵다. 한국어 릴리스 체크리스트에 “빠른 전환 시 시각적 안정성”을 유지하고 수동 게이트를 릴리스 블로커로 공식화한 결정이 실증됐다.

### xterm proposed API·CSS·포커스는 통합 게이트 필수 (Issue 6)

xterm 업그레이드나 애드온 도입 시 `allowProposedApi`, CSS 임포트, 포커스 이동을 매번 확인해야 한다. 이 항목들은 `.nexus/memory/pattern-phase-gate-checklist.md`의 네이티브 smoke 범주로 고정했다.

### 워크스페이스 경로 주입은 통합 계층에서 검증 (Issue 2)

cwd 불일치는 단위 테스트에서는 발견되지 않았다. 워크스페이스 열기·닫기·전환 게이트에 “터미널 cwd가 선택된 워크스페이스 절대 경로와 일치” 기준을 추가했다.

---

## 5. 이관 역참조

- `CHANGELOG.md` — Phase A PASS 판정·범위·이관 결정 요약
- `.nexus/memory/pattern-phase-gate-checklist.md` — 재사용 가능한 체크리스트 구조 고정

원본 상세 증거의 git 추적 자료는 본 파일이 작성된 시점 이후 정리되었다. 시점 의존 단편 증거는 `.nexus/state/artifacts/` 또는 `nx_artifact_write` MCP 툴로 보관하고, 사이클 종료 시 영구 가치 있는 학습은 본 파일 같은 memory로 추출한다.
