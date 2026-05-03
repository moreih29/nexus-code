# Files Panel RUNBOOK

작성일: 2026-05-03 / Plan ID: 7 / 관련 commit: PR1+PR2 합본 (20adf21) + 본 후속 PR

이 문서는 자동 테스트로 잡기 어려운 시각/타이밍/시스템 동작을 수동 검증하는 절차를 모은다.

**사용 방법**: 각 항목의 [단계]를 차례로 따라가고, [합격 기준]에 명시된 모든 조건이 PASS면 통과. 결과는 [결과 기록 칸]에 기록 (작성자/날짜/PASS·FAIL·환경).

**회귀 등록 절차**: 새로운 회귀 발견 시 항목을 추가하되 기존 ID는 절대 재사용하지 않는다. ID 채번 규칙: 신규 회귀는 `RUNBOOK-FU-NN` 형식을 사용하며, 마지막 ID 번호 + 1을 부여한다 (현재 마지막 ID = FU-04, 다음 신규 항목 = FU-05). 항목을 추가한 본인이 [결과 기록 칸]의 작성자 칸에 이름을 기재한다. GitHub Issue 또는 PR 링크가 있으면 해당 항목 헤딩 바로 아래 첫 줄에 `Related: #<번호>` 형태로 명시한다.

---

## RUNBOOK-PR2-01 — 메모리 leak 수동 검증

### 목표

워크스페이스/폴더 expand·collapse를 반복해도 chokidar FSWatcher 인스턴스와
setTimeout/setInterval 타이머가 GC되어 메모리가 누적되지 않음을 확인.

### 사전 조건

- macOS, dev 빌드 (`bun run dev`).
- Electron DevTools 열림 (Cmd+Option+I).
- 실험용 워크스페이스 (~50개 폴더 포함) 준비.

### 단계

1. DevTools → Memory 탭 → Heap snapshot **Snapshot 1** 촬영.
2. 워크스페이스 5개 expand → collapse 반복 (5회).
3. 워크스페이스 add → remove 반복 (3회).
4. Heap snapshot **Snapshot 2** 촬영.
5. Comparison 모드로 Snapshot 1 → Snapshot 2 비교.

### 합격 기준

- `FSWatcher` 인스턴스 카운트가 현재 watched 디렉토리 수와 정확히 일치.
- `chokidar` 관련 retained object 0개 (워크스페이스 모두 제거 후): Comparison 모드에서 Class filter에 `FSWatcher` 입력 후 'New' 컬럼이 0이고 'Deleted' 컬럼이 'Allocated'와 동일한지 확인.
- Detached DOM 노드 leak 없음.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____

---

## RUNBOOK-PR2-02 — 앱 재시작 후 펼침 복원

### 목표

워크스페이스에서 펼친 폴더가 앱 재시작 후 정확히 복원되는지 확인.

### 사전 조건

- macOS, dev 빌드 또는 packaged 앱.
- 워크스페이스 1개 활성, 폴더 3개 이상 깊이 다양한 위치에 expand.

### 단계

1. 워크스페이스 활성 후 폴더 A (depth 1), B (depth 2 within A), C (depth 1 다른 형제) expand.
2. 트리 상태 시각 캡처 (스크린샷).
3. Cmd+Q로 앱 완전 종료.
4. 앱 재실행.
5. 같은 워크스페이스 활성 후 트리 상태 비교.

### 합격 기준

- A, B, C 모두 expanded 상태로 복원.
- 자식 노드 readdir도 끝나 있어 시각적 깜박임 없음.
- 종료 직전 활성 워크스페이스 (Sidebar에서 highlighted된 항목)도 동일.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____

---

## RUNBOOK-FU-01 — Cmd+Shift+R PTY 생존 + 트리 재로드

### 목표

하드 리로드 단축키(Cmd+Shift+R)가 페이지 reload를 발생시키지 않고 트리만 재로드,
PTY는 생존하는지 확인.

### 사전 조건

- macOS, dev 빌드 (`bun run dev`).
- 워크스페이스 활성, 터미널 탭 1개 이상 열려 있고 PTY 동작 중.

### 단계

1. 터미널 탭에서 `echo before-reload` 실행하고 출력 확인.
2. Cmd+Shift+R 누름.
3. 트리 깜박임 시각 확인.
4. 같은 터미널 탭에서 `echo after-reload` 실행.

### 합격 기준

- 페이지 전체 reload 없음: DevTools Network 탭에 새 document 요청이 기록되지 않음 (페이지 reload 시 `index.html` 재요청이 보임).
- 트리 root readdir 재발화로 시각적 갱신.
- 터미널 탭의 이전 출력(before-reload)이 그대로 남아있고 새 출력(after-reload)도 정상 표시.
- 활성 워크스페이스/탭 모두 보존.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____

---

## RUNBOOK-FU-02 — Sidebar/FilesPanel ResizeHandle 히트영역 안 겹침

### 목표

Sidebar 우측 핸들(rightInside)과 FilesPanel 우측 핸들(rightCentered)이 클릭 시
서로 잡히지 않는지 확인.

### 사전 조건

- macOS, dev 빌드 (`bun run dev`).
- 워크스페이스 활성. Sidebar/FilesPanel 모두 보임.

### 단계

1. Sidebar 우측 경계의 정중앙 위 마우스 hover. col-resize 커서 표시 확인.
2. 4px 안쪽으로 이동해 Sidebar 내부 클릭 → drag.
3. drag 시작 시 sidebarWidth만 변하고 filesPanelWidth는 변하지 않음 확인.
4. FilesPanel 우측 경계 위 hover. col-resize 커서 확인.
5. drag → filesPanelWidth만 변경.

### 합격 기준

- Sidebar 핸들 hit-area가 사이드바 안쪽 8px 영역에만 활성.
- FilesPanel 핸들이 우측 경계 위에 centered.
- 두 핸들이 동시에 잡히는 영역 없음.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____

---

## RUNBOOK-FU-03 — 자식 dir readdir 시각 피드백

### 목표

자식 디렉토리 expand 시 chevron의 시각적 변화(opacity 등)로 loading 상태가
사용자에게 인지되는지 확인.

### 사전 조건

- macOS, dev 빌드 (`bun run dev`).
- 큰 디렉토리 (1000+ entries) 포함된 워크스페이스.

### 단계

1. 큰 디렉토리 (예: `~/large-repo/node_modules/.pnpm` 등 readdir이 100ms+ 걸리는 곳)
   노드를 클릭해 expand.
2. expand 클릭 직후 chevron 시각 변화 확인.
3. children 표시 직전까지 chevron 상태 관찰.

### 합격 기준

- expand 클릭 직후 chevron opacity 50%로 떨어지거나 pulse.
- children 표시되면 chevron 정상 (opacity 100%).
- 작은 readdir(<50ms)에서는 깜박임이 거의 없음.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____

---

## RUNBOOK-FU-04 — 큰 트리 drag 60fps 유지

### 목표

대량 행이 떠 있는 상태에서 ResizeHandle drag 시 jank 없이 60fps 유지되는지 확인
(T-03 ref-mirror 패턴 회귀 검증).

### 사전 조건

- macOS, dev 빌드 (`bun run dev`).
- 워크스페이스 활성. 트리 100+ 행 보이도록 폴더 여러 개 expand.

### 단계

1. DevTools → Performance 탭 → Record 시작.
2. Sidebar ResizeHandle drag 좌우로 5초간 흔들기.
3. FilesPanel ResizeHandle drag 좌우로 5초간 흔들기.
4. Recording 정지.
5. Frame chart에서 dropped frame 검색.

### 합격 기준

- Sidebar drag 동안 dropped frame 5% 미만.
- FilesPanel drag 동안 dropped frame 5% 미만.
- Long task (>50ms) 발생 0회.

### 결과 기록 칸

- 작성자: ____
- 날짜: ____
- 환경 (OS/build): ____
- 결과 (PASS/FAIL): ____
- 비고: ____
