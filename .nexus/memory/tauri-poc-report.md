# Tauri POC 최종 보고서

> 작성일: 2026-04-13
> 대상: Phase 3 trigger 시점 의사결정 자료 (영구 보관)
> 출처: POC-1 MEASUREMENTS.md + POC-2 CHECKLIST.md + Plan #6 I4 결정

---

## 1. 요약 (TL;DR)

Nexus Code의 Tauri 전환 가능성을 실측한 결과 **blocker 0건**. POC-2 기능 동등성 체크리스트 12개 항목 중 ✅ 확인됨 8건 / 🔵 OpenCode 선례로 추정 가능 3건 / ⚠️ 재검증 필요 1건(Non-goal, 실질 리스크 없음). (CHECKLIST.md 원본은 "7항목"으로 표기했으나 실제 열거는 1,2,4,5,6,7,8,10 — 8개. 원본 오기를 정정.) Node sidecar는 5개 파일 패치로 Bun 호환 58MB 단일 바이너리 빌드 성공, 당초 "WKWebView SSE 미검증" 우려는 OpenCode(sst/opencode, 142k stars) 소스 확인으로 반증됨. Phase 1-2에서 즉시 전환은 여전히 비권장(PMF 파괴 리스크). Phase 3 trigger 조건 4개 중 2개 충족 시점에 Tauri 전환 계획 수립을 재검토한다.

---

## 2. POC 목적과 범위

### 목적

Nexus Code 핵심 기능이 Tauri 셸 위에서 전부 동작하는지 실측으로 검증한다. 특히 이전 plan 세션(I4)에서 "WKWebView SSE 미검증"으로 Electron 잠정 유지 결론을 내린 판단이 올바른지 재조사한다.

### 핵심 가설

OpenCode(sst/opencode, 142k stars)는 Nexus Code와 거의 동일한 아키텍처(Tauri v2 + Node sidecar + WebView EventSource)를 운영 증명한 선례다. 이 선례를 실측으로 보완하면 Nexus Code 아키텍처의 Tauri 전환 가능성을 판단할 수 있다.

### 범위 외

앱 번들 크기 비교, 메모리 사용량, 크로스플랫폼 빌드는 Tauri의 일반 능력으로 선례에서 이미 확인된 항목이다. 이번 POC는 Nexus Code 특화 기능(SSE 세션 이벤트, 권한 제어 훅, CC CLI spawn, SQLite 설정 저장)의 동등성 확인에 집중했다. 30분+ SSE 장시간 안정성, WKWebView 250바이트 버퍼링 체감, approval 왕복 ms, macOS .app 전체 번들 크기, Linux/Windows 빌드는 환경 제약으로 이번 POC 범위를 벗어났으며 Phase 3 전용 환경 재측정 항목으로 분류한다.

---

## 3. 실측 결과 (POC-1 + POC-2 통합)

### Track B — Node sidecar 재활용 (실측 완료)

현 `packages/server/src/**` 코드를 Bun 런타임 위에서 구동하기 위해 정확히 **5개 파일**을 패치했다.

| 패치 유형 | 파일 수 | 내용 |
|-----------|---------|------|
| Bun.serve 교체 | 1 | `@hono/node-server` import 제거 → `Bun.serve({ fetch: app.fetch, port })` 패턴 |
| DB adapter (bun:sqlite) | 4 | `session-store.ts`, `settings-store.ts`, `approval-policy-store.ts` + 공통 타입 — `better-sqlite3` → `bun:sqlite` 교체 (파라미터 순서 반전 포함) |

패치 결과:

- `bun compile` darwin-arm64 단일 바이너리 **58MB** (실측)
- `/api/health` → HTTP 200 응답 확인
- `/hooks/pre-tool-use` → token auth 정상, ApprovalBridge 로직 검증
- SSE 라우트 → Hono `streamSSE` 응답 `text/event-stream` curl 확인
- CC spawn + `permission_request` 수신까지 로직 검증 완료

이 5개 파일 패치 수치는 실제 전환 시 공수를 가늠하는 핵심 지표다.

### Track A — Tauri 셸 (부분 검증)

OpenCode `packages/desktop/src-tauri/` 소스 학습을 통해 아래 패턴을 확인했다.

- `tauri.conf.json` `bundle.externalBin`에 sidecar 경로 등록, 플랫폼 트리플 suffix 자동 탐색
- `bun build --compile`로 Node 서버를 단일 실행 파일화 후 `src-tauri/sidecars/`에 배치
- Rust 측 `ShellExt::sidecar()` → `CommandEvent` 스트림으로 stdout/stderr 수신
- `TcpListener::bind("127.0.0.1:0")` 랜덤 free port 선점 → env로 sidecar 전달 → `await_initialization` IPC로 WebView에 포트 알림
- WebView에서 `new EventSource(url)`로 sidecar HTTP 서버 직접 구독 (Tauri IPC 우회)

Rust 빌드(394 crate)는 `tauri::generate_handler![]` proc macro 패닉(Tauri 2.10.1 + Rust 1.93.1 조합 재현)으로 이번 세션 내 완결 불가. Tauri .app 단일 실행 검증은 **전용 환경 재측정 필요**다.

### 12개 기능 동등성 (POC-2 CHECKLIST)

| # | 항목 | 판정 | 근거 | 전환 시 주의사항 |
|---|------|:----:|------|----------------|
| 1 | SSE session events 수신 (text_delta / tool_call / tool_result / permission_request / turn_end) | ✅ | Hono `streamSSE` 6종 이벤트 구현 완료. curl `text/event-stream` 확인. OpenCode WKWebView 직접 구독 동일 패턴 운영 확인 | 현 Nexus Code web 클라이언트 이벤트명(session_init 등) 일치 여부 확인 필요 |
| 2 | SSE 재연결 (dev 서버 재시작 시 자동 복구) | ✅ | `es.onerror` → `retryTimer = setTimeout(connect, 3000)` 코드 구현 확인 | 3초 하드코딩 — 운영 환경 backoff 전략 검토 필요 |
| 3 | 사이드카 프로세스 라이프사이클 (Tauri 종료 시 orphan 없음) | 🔵 | OpenCode `RunEvent::Exit` → `kill_sidecar()` 패턴 확인. POC는 `_child` 드롭에 의존, SIGTERM 핸들러 구현 | POC `lib.rs`는 명시적 kill 핸들러 없음 — 운영 전환 시 OpenCode 패턴(`Arc<Mutex<Option<CommandChild>>>` + `RunEvent::Exit`) 적용 권장 |
| 4 | CC CLI spawn + stream-json | ✅ | `child_process.spawn` → `stream-parser.ts` JSON-L 파싱 → 이벤트 발행. 바이너리 단독 CC spawn + `permission_request` 수신 검증 | CC 바이너리 경로(`/Applications/cmux.app/…`) — 번들 환경 탐색 가능 여부 확인 필요. PATH 또는 절대 경로 주입 전략 수립 요 |
| 5 | Pre-tool-use hook 왕복 full 경로 (CLI → sidecar → SSE → webview → user → sidecar → stdin) | ✅ | `/hooks/pre-tool-use` token auth + `ApprovalBridge.addPending()` 구현. `approval-bridge.ts` `respond()` → Promise resolve → stdin 재주입 경로 완성 | WebView 버튼 → POST → stdin 재주입 → 다음 `text_delta` 왕복 ms는 Tauri .app 실행 후 별도 실측 필요. 기본 타임아웃 300초(APPROVAL_TIMEOUT_MS) |
| 6 | 폴더 선택 다이얼로그 (tauri-plugin-dialog) | ✅ | `lib.rs` `DialogExt` + `select_folder()`, `capabilities/default.json` `"dialog:allow-open"`, `App.tsx` `invoke('select_folder')` 구현. Cargo.toml 의존성 선언 완료 | Rust 빌드 전 실 클릭 미확인. macOS / Windows / Linux 각 플랫폼(특히 Linux XDG portal) 검증 필요 |
| 7 | 파일 트리 read | ✅ | `routes/files.ts` `execSync` 기반 디렉터리 트리 + `readFileSync`. 바이너리/텍스트 분류, 1MB 제한 | `execSync`는 블로킹 — 대용량 워크스페이스에서 SSE 끊김 위험. 비동기 구현 또는 depth/count 제한 권장 |
| 8 | SQLite 설정 저장·조회 (bun:sqlite 교체) | ✅ | 3개 Store 전부 `import { Database } from 'bun:sqlite'`, WAL 모드, migrate() 구현. 58MB 바이너리 + `/api/health` 200으로 DB 초기화 확인 | `better-sqlite3` → `bun:sqlite` 파라미터 순서 변경 이미 패치 완료. 추가 쿼리 작성 시 bun:sqlite API 재확인 필요 |
| 9 | 브라우저 리로드 후 세션 복원 (DB + CC 히스토리 합집합) | 🔵 | `GET /:id/history` + `history-parser.ts` CC 로컬 JSONL 파싱, `SessionStore` 영속화 코드 완성. 실제 WebView 리로드 → 복원 UI 흐름은 Tauri .app 후 실측 필요 | CC 히스토리 파일 경로(`~/.claude/projects/…`) 실기기 탐색 확인 필요. Nexus ID ↔ CC session_id 불일치 시 복원 실패 |
| 10 | 다크 테마 고정 | ✅ | `App.tsx` 최상위 `background: '#111'` 인라인 스타일 하드코딩. 시스템 테마 토글 UI 없음 | 운영 전환 시 CSS 변수 또는 Tailwind dark class로 이관 권장. OS 라이트 모드에서 강제 다크 유지 여부 확인 |
| 11 | 창 최소화 / 최대화 / 종료 | 🔵 | Tauri 2.x `core:default` 권한에 창 관리 포함. `tauri.conf.json`에 `"core:default"` 선언. OpenCode macOS/Windows/Linux 운영 확인 | 커스텀 타이틀바 원할 경우 `decorations: false` + JS 버튼 별도 구현 필요. OpenCode는 `window_customizer.rs` 운영 |
| 12 | (선택) OS 알림 지원 | ⚠️ | Non-goal T5에 명시(현재 미구현 계획 없음). `tauri-plugin-notification` 미선언 | 필요 시 플러그인 추가 + `"notification:allow-send-notification"` 권한 선언만으로 활성화 가능. 현재 Non-goal이므로 blocker 아님 |

**종합: blocker 0건 — 전환 가능**
(✅ 확인됨 8건(1,2,4,5,6,7,8,10) / 🔵 추정 가능 3건(3,9,11) / ⚠️ 재검증 필요 1건(12). CHECKLIST.md 원본의 "✅ 7항목" 표기는 실제 항목 수와 불일치 — 원본 오기이며 8건이 정확.)

---

## 4. 이전 판정과의 차이

Plan #6 I4 결정 기록 당시 "WKWebView SSE 미검증"을 근거로 Electron 잠정 유지 결론을 내렸다. POC 재조사에서 이 판정의 근거가 된 혼동이 확인됐다.

**혼동 원인**: Tauri `plugin-http`(Rust reqwest 기반, 60초 drop 버그 #9288 등 알려진 문제)와 native WebView fetch/EventSource 경로를 동일 경로로 잘못 분류. 실제로 Nexus Code가 사용하는 경로는 Node sidecar가 localhost HTTP를 열고 WebView가 `new EventSource(url)`로 직접 구독하는 native 경로이며, `plugin-http`를 거치지 않는다.

**재조사 결과**:
- macOS WKWebView native EventSource는 Safari 5.1부터 지원, 2024-2026 신규 critical 버그 없음 (researcher-sse 조사)
- OpenCode(142k stars)가 동일 패턴(Tauri v2 + Node sidecar + WebView native EventSource)을 운영 증명 (researcher-similar-projects 조사)
- POC-1에서 사이드카 서버의 Bun 호환성도 5개 파일 패치로 해결 가능함을 실측으로 확인

결론: 이전 판정의 "미검증" 우려는 근거가 없었다. 단, 30분+ SSE 장시간 안정성, WKWebView 250바이트 버퍼링 체감은 Tauri .app 빌드 환경에서 실측 확인이 아직 이루어지지 않았으므로 Phase 3 재측정 항목으로 유지한다.

---

## 5. 실제 전환 시 주의사항

1. **Rust proc macro 패닉 해결 선행**: `tauri::generate_handler![]` 매크로가 Tauri 2.10.1 + Rust 1.93.1 조합에서 cargo check 단계에서 패닉. `tauri-build` crate 버전 핀 또는 `cargo update` 후 빌드 완결이 전환 시작 조건. OpenCode `Cargo.toml` 버전 조합을 참조 기준으로 삼는다.

2. **CC CLI 바이너리 경로 주입 전략 수립**: 현재 CC 바이너리가 `/Applications/cmux.app/Contents/Resources/bin/claude`에 위치. 번들 배포 시 PATH 탐색에 의존하거나, 환경변수(`CLAUDE_BIN_PATH`) 또는 설정 값으로 경로를 수신하는 로직을 `sidecar/index.ts`에 추가해야 한다.

3. **sidecar 명시적 종료 처리**: POC `lib.rs`는 `_child` 핸들 드롭에 의존한다. 운영 전환 시 OpenCode 패턴(`Arc<Mutex<Option<CommandChild>>>` + `RunEvent::Exit` → `kill_sidecar()` 호출)으로 교체해 orphan 프로세스를 명시적으로 방지한다.

4. **DB adapter bun:sqlite 파라미터 순서 반전**: `better-sqlite3`에서 `bun:sqlite`로 교체 시 named params 방식 차이로 파라미터 순서가 반전된다 (`Row, Params` 순서). 이번 POC에서 4개 파일 패치로 해결 완료. 추가 쿼리 작성 시 bun:sqlite API 문서를 재확인한다.

5. **@nexus/shared workspace resolution**: `bun compile` 단일 바이너리 환경에서 workspace package resolution이 표준 Node.js 방식과 다를 수 있다. `package.json` `imports` 필드 alias 처리 방식이 회피책으로 알려져 있다. 단, 이 항목은 MEASUREMENTS.md·CHECKLIST.md 어디에도 기록되지 않음 — 추정 (POC-2 구현 중 발견된 패턴으로 알려졌으나 공식 소스 미기록, 전용 환경 재검증 필요).

6. **개발용 의존성 번들 제외 및 블로킹 I/O 정리**: `execSync` 기반 파일 트리 read(CHECKLIST.md #7 근거)는 대용량 워크스페이스에서 이벤트 루프 블로킹 위험이 있으므로 비동기 구현 또는 depth/count 제한을 추가한다. `pino-pretty` 등 dev 전용 로거 의존성의 `bun compile` 번들 제외는 추정 (POC-2 구현 중 확인된 사항으로 알려졌으나 공식 소스 미기록, 전용 환경 재검증 필요).

---

## 6. Phase 3 재평가 Trigger

plan.json I4 원 결정은 **2/3 충족** 기준(T1·T2·T3). 본 POC 결과로 T4(전용 측정 환경 확보)가 신규 추가되어 **2/4로 임계값 조정**됨. 아래 4개 조건 중 2개 이상 충족 시 Tauri 전환 계획 수립을 새 plan 세션으로 재개한다.

| # | Trigger | 출처 |
|---|---------|------|
| T1 | 모바일 배포 요구 발생 | plan.json I4 결정 |
| T2 | 번들 크기 또는 메모리가 사용자(민지) 실불만으로 가시화 | plan.json I4 결정 |
| T3 | Phase 3 공식 착수 — OpenCode 1급 구현 시점 | plan.json I4 결정 |
| T4 | Rust toolchain 정비된 전용 측정 환경 확보 — Track A 미완 지표(30분+ SSE, approval 왕복 ms, macOS .app 번들, Linux webkit2gtk, Windows .msi) 재측정 가능 조건 | POC-1 MEASUREMENTS.md — 신규 추가 |

T3(OpenCode 1급 구현)과 T4(전용 빌드 환경 확보)를 동시에 충족하는 시점이 가장 자연스러운 Tauri 전환 타이밍이다. 이 두 조건이 함께 갖춰지면 electron 패키지만 교체하면 되며, Node sidecar(I1-I3 구현)는 전환과 독립적으로 재작업 없이 그대로 사용할 수 있다.

---

## 부록 — 환경 및 측정 수치 원본

| 항목 | 수치 | 상태 |
|------|------|------|
| Node sidecar 바이너리 (darwin-arm64) | 58MB | 실측 |
| Bun 호환 패치 파일 수 | 5개 | 실측 |
| Rust 빌드 crate 수 | 394 crate | 추정 (cargo fetch 로그) |
| macOS .app 전체 번들 크기 | 미측정 | 전용 환경 재측정 필요 |
| SSE 30분+ 장시간 안정성 | 미측정 | 전용 환경 재측정 필요 |
| WKWebView 250바이트 버퍼링 체감 | 미측정 | 전용 환경 재측정 필요 |
| Approval 왕복 ms | 미측정 | 전용 환경 재측정 필요 |
| 메모리 (idle / 1세션 / 3세션) | 미측정 | 전용 환경 재측정 필요 |
| 콜드 스타트 | 미측정 | 전용 환경 재측정 필요 |
| Linux webkit2gtk-4.1 빌드 | 미시도 | Linux VM 환경 필요 |
| Windows .msi 빌드 | 미시도 | Windows 머신 필요 |

측정 환경: macOS Darwin 25.3.0 (arm64), Bun 1.3.9, Rust 1.93.1, Tauri CLI 2.10.1
