# Phase 2 Cycle B 실행 기록

> 작성일: 2026-04-14
> 대상: Plan #8 Phase 2 Cycle B 완료 기록 (영구 보관)
> 출처: Plan #8 Tasks 1–5 실행 결과 + cycle-a-report.md + tauri-poc-report.md §5 + tauri-migration-plan.md (c)

---

## 1. 요약 (TL;DR)

Cycle A에서 이월된 최대 blocker — **pino-pretty transport crash** — 를 **삼중 안전(A+B+C)** 으로 완전 해소했다. 초기 계획(A+B 이중 안전)에서 C가 추가된 것은 `--define` 인자가 실측에서 효과가 없음을 확인한 직접 결과다. sidecar 단독 smoke(포트 49902): HTTP 200, `.app` smoke(포트 56772): HTTP 200으로 양쪽 모두 ALIVE 판정.

dev orchestrator(`scripts/dev.ts`)를 electron 블록에서 Tauri 블록으로 전환하고, POC 부록 B에서 사전 기록된 함정 5건을 모두 완료 상태로 격상했다. **backlog 0** — 미해결 이관 항목 없음.

Electron 폐기는 **Cycle C**, 크로스플랫폼 빌드 검증 및 30분+ SSE 장시간 안정성 실측은 **Cycle D**로 이관한다.

---

## 2. 범위와 목표

### Cycle B 스코프

migration-plan.md (c)에서 정의한 Phase 2 분할 계획에서 Cycle B가 담당하는 범위:

| 항목 | 내용 |
|------|------|
| 주목표 | pino-pretty crash 해소 (삼중 안전 적용) |
| 부목표 1 | dev orchestrator Tauri dev 전환 |
| 부목표 2 | 부록 B 함정 5건 완료 격상 및 회귀 확인 |
| 부목표 3 | `.app` smoke 재검증 (sidecar 생존 + `/api/health` 응답) |
| 범위 밖 | packages/electron 폐기, 크로스플랫폼 빌드, 30분+ SSE |

### Cycle C/D 경계

| Cycle | 담당 |
|-------|------|
| **C** | `packages/electron` 폐기 + `dev-smoke-protocol.md` 갱신 + `dialog:allow-open` 확인 |
| **D** | 30분+ SSE 장시간 안정성 실측 + Linux webkit2gtk 빌드 + Windows .msi 빌드 |

---

## 3. 실행 단계별 결과

### 3.1 Task 결과 요약

| Task | 내용 | 판정 | 비고 |
|------|------|:----:|------|
| 1 | pino-pretty 번들 제외 (삼중 안전 A+B+C) | PASS | --define 실측 실패 → C 추가 |
| 2 | dev orchestrator electron → Tauri 전환 | PASS | scripts/dev.ts 193~208행 교체 |
| 3 | 회귀 확인 (api 모듈 5종 + SSE 이벤트 + RunEvent) | PASS | hook_event 신규 추가 포함 |
| 4 | 재빌드 + `.app` smoke 재검증 | PASS | sidecar PID 33012 생존, /api/health 200 |
| 5 | Tester 정적 검증 | PASS | 3항목 모두 확인 (로그 디렉터리 N/A 수용) |

---

## 4. pino-pretty 해결 상세

### 4.1 Cycle A crash 원인

Cycle A smoke에서 sidecar가 부팅 즉시 crash. 스택 트레이스:

```
error: unable to determine transport target for "pino-pretty"
  at fixTarget (/$bunfs/root/nexus-sidecar-aarch64-apple-darwin:2602:15)
  at transport (…:2582:33)
  at createLogger (…:5944:43)
Bun v1.3.9 (macOS arm64)
```

`packages/server/src/logger.ts`가 `NODE_ENV !== 'production'`일 때 `pino.transport({ target: 'pino-pretty' })`를 설정하고, `bun compile` 번들 환경에서 pino-pretty worker thread가 dynamic require에 실패하는 것이 원인이다. POC 보고서 §5 주의사항 #6에서 예고된 항목이 실측으로 확정된 결과다.

### 4.2 초기 계획 — A+B 이중 안전

| 안전장치 | 방법 | 목표 |
|---------|------|------|
| A | `compile-sidecar.ts` cmd에 `'--define', 'process.env.NODE_ENV="production"'` 인자 추가 + `env: { NODE_ENV: 'production' }` Bun.spawn env 설정 | 컴파일 시점에 NODE_ENV 주입 |
| B | `packages/tauri/src-tauri/src/lib.rs` sidecar spawn에 `.env("NODE_ENV", "production")` 추가 | 런타임 spawn 시 env 전달 |

### 4.3 --define 실측 실패 → C 추가 배경

A를 적용하고 재컴파일 후 검증:

```bash
strings nexus-sidecar-aarch64-apple-darwin | grep -c pino-pretty
# 결과: 2
```

`--define` 인자 적용 후에도 바이너리 내 `pino-pretty` 문자열이 2건 잔존함을 실측으로 확인했다. 이는 `--define`이 컴파일 시점 상수 치환에는 작동하나, pino의 **런타임 dynamic require** 경로에는 효과가 없음을 의미한다. A+B만으로는 런타임 참조가 차단되지 않을 위험이 남는다.

이에 근본 원인인 소스 코드 자체를 수정하는 **C(logger.ts 소스 수정)** 를 삼중 안전으로 추가했다.

### 4.4 최종 삼중 안전 구성

| 안전장치 | 적용 위치 | 내용 |
|---------|----------|------|
| A | `packages/server/scripts/compile-sidecar.ts` | cmd에 `'--define', 'process.env.NODE_ENV="production"'` 추가 + `env: { NODE_ENV: 'production' }` Bun.spawn env |
| B | `packages/tauri/src-tauri/src/lib.rs` | sidecar spawn에 `.env("NODE_ENV", "production")` 추가 |
| C | `packages/server/src/logger.ts` | `isBundled = import.meta.url.startsWith('file:///$bunfs/')` 감지 → bundled 환경에서 `isDev` 강제 false → transport 인자가 `undefined`로 전달되어 pino-pretty 참조 자체 안됨 |

pino-pretty 문자열은 바이너리에 여전히 2건 잔존하지만, 삼중 안전으로 런타임 참조 경로가 완전히 차단된다.

### 4.5 단독 실행 smoke 결과

| 항목 | 수치 |
|------|------|
| 컴파일 EXIT | 0 |
| 바이너리 크기 | 58.3 MB |
| 컴파일 소요 | 130ms |
| smoke 포트 | 49902 |
| `/api/health` | HTTP 200 |
| 응답 본문 | `{"status":"ok","timestamp":"2026-04-14T02:23:13.670Z","hooks":{"active":0}}` |

---

## 5. 회귀 확인 결과

### 5.1 컴파일 파이프라인

`compile-sidecar.ts`의 `outDir`이 `resolve(serverRoot, '../tauri/src-tauri/binaries')`로 Phase 1 구조 그대로 유지됨을 확인했다. Phase 1에서 수립한 sidecar 배치 경로가 회귀 없이 보존된다.

### 5.2 Web API 모듈 계약

`packages/web/src/api/` 5개 모듈의 URL 경로가 sidecar 계약과 일치함을 확인했다:

| 모듈 | 경로 |
|------|------|
| sessions | `/api/sessions`, `/api/sessions/:id/prompt`, `/api/sessions/:id/cancel`, `/api/sessions/:id/resume`, `/api/sessions/:id/history`, `/api/sessions/:id/status` |
| approvals | `/api/approvals/:id/respond`, `/api/approvals` |
| workspaces | `/api/workspaces` |
| health | `/api/health` |

### 5.3 SSE 이벤트 계약

`use-sse.ts`에서 처리하는 이벤트명 10종이 sidecar 계약과 일치함을 확인했다:

| 이벤트 | 비고 |
|--------|------|
| `session_init` | |
| `text_delta` | use-sse.ts:52에서 `text_chunk`로 매핑 (dedupe) |
| `tool_call` | |
| `tool_result` | |
| `permission_request` | |
| `permission_settled` | |
| `turn_end` | |
| `error` | |
| `rate_limit` | |
| `hook_event` | **신규 추가** — Cycle B에서 sidecar 계약에 반영 |

`text_delta` / `text_chunk` 중복 이슈(POC 부록 B 함정 #3): `use-sse.ts:52`에서 `eventName === 'text_delta' ? 'text_chunk'` 매핑으로 이미 해소되어 있음을 확인. UI 측 완결 상태로 부록 B 완료 격상.

### 5.4 Rust sidecar 종료 핸들러

`lib.rs`의 `RunEvent::Exit + Arc<Mutex<Option<CommandChild>>> + child.kill()` 패턴이 Phase 1 + Cycle A에서 수립된 그대로 유지됨을 확인했다. Cycle A borrowck 해소 결과 회귀 없음.

---

## 6. dev orchestrator 전환

### 6.1 변경 내용

`scripts/dev.ts` 193~208행의 electron 블록을 Tauri 블록으로 교체했다.

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| cmd | `packages/electron` 실행 명령 | `['bunx', 'tauri', 'dev']` |
| cwd | `packages/electron` | `packages/tauri` |
| prefix | `[electron]` | `[tauri]` |
| 색상 | `\x1b[35m` | `\x1b[35m` (유지) |
| 헤더 주석 | "일렉트론 실행" | "tauri dev 실행" |

### 6.2 tauri.conf.json 연동

`packages/tauri/tauri.conf.json`의 `beforeDevCommand`를 `"bun run --filter @nexus/web dev"`에서 `""`(빈 문자열)로 수정했다. `scripts/dev.ts`가 web 개발 서버를 이미 관리하므로 tauri.conf.json에서의 중복 실행을 방지하기 위한 조치다.

---

## 7. .app smoke 재검증

### 7.1 빌드 수치

| 단계 | 결과 | 수치 |
|------|:----:|------|
| sidecar 재컴파일 | PASS | 58.3 MB, 130ms, EXIT 0 |
| `cargo build --release` | PASS | **1m 24s**, Rust 1.93.1, tauri 2.9.5, warnings 2건 |
| `bunx tauri build` | PASS | EXIT 0, .app 64M + DMG 재생성 |

cargo build --release 소요 시간이 Cycle A(1m 27s) 대비 1m 24s로 약 3초 단축되었다. warnings 2건(미사용 import, dead code field)은 Cycle A에서 이관된 항목으로 기능 영향 없음.

### 7.2 .app 구동 smoke

```bash
open "packages/tauri/src-tauri/target/release/bundle/macos/Nexus Code.app"
```

| 항목 | 결과 |
|------|------|
| nexus-tauri (Rust shell) | 생존 (PID 별개, 미실측 — smoke 범위 밖) |
| nexus-sidecar PID | **33012 생존** (Cycle A에서 crash로 즉사했던 프로세스) |
| sidecar listening port | **56772** (Tauri `pick_free_port()` 랜덤 할당) |
| `/api/health` | **HTTP 200** |
| 응답 본문 | `{"status":"ok","timestamp":"2026-04-14T02:27:25.767Z","hooks":{"active":0}}` |

nexus-sidecar PID 생존이 Cycle B의 핵심 검증 항목이다. Cycle A에서 pino-pretty crash로 즉사했던 프로세스가 이번 cycle에서 안정적으로 살아있음을 확인했다.

### 7.3 로그 디렉터리 미생성 사유

`~/.nexus-code/logs/` 디렉터리가 smoke 시점에 생성되지 않는 것은 정상 동작이다. workspace-logger는 **session 단위**로 파일을 생성하므로, 창을 열고 workspace 등록 + session 시작 시에만 디렉터리와 파일이 생성된다. 본 cycle의 acceptance 기준은 `/api/health` 응답으로 대체하여 충족 판정했다.

---

## 8. 이관 항목 및 backlog 상태

### 8.1 POC 부록 B 함정 5건 — 전원 완료

| 항목 | 내용 | 완료 시점 |
|------|------|----------|
| #1 sidecar 재빌드 파이프라인 | compile-sidecar.ts outDir 구조 보존 확인 | Phase 1 + Cycle B 회귀 확인 |
| #2 UI-sidecar 계약 정렬 | web/src/api/ 5개 모듈 URL 경로 일치 확인 | Phase 1 + Cycle B 회귀 확인 |
| #3 text_delta/text_chunk 중복 | use-sse.ts:52 dedupe 매핑 확인 | Phase 1 구현 + Cycle B 완료 격상 |
| #4 sidecar 종료 Rust 핸들러 | RunEvent::Exit + Arc 패턴 유지 확인 | Phase 1 + Cycle A borrowck 해소 |
| #5 pino-pretty 번들 제외 | 삼중 안전(A+B+C) 적용 완료 | **Cycle B** |

**backlog 0** — 미해결 이관 항목 없음.

### 8.2 Cycle C 착수 항목

| 항목 | 내용 | 선결 |
|------|------|------|
| packages/electron 폐기 | 디렉터리 삭제, root package.json workspaces 제거 | Cycle B 완료 (본 cycle) |
| IPC select_folder 확인 | capabilities/default.json `dialog:allow-open` 이미 Tauri 플러그인 기반 적용 확인 | — |
| dev-smoke-protocol.md 갱신 | Tauri 기준으로 문서 업데이트 | Cycle B 완료 (본 cycle) |

### 8.3 Cycle D 착수 항목

| 항목 | 내용 |
|------|------|
| 30분+ SSE 장시간 안정성 | `.app` 산출 환경에서 실측 (Cycle B에서 .app 확보됨) |
| Linux webkit2gtk 빌드 | Linux VM 환경 필요 |
| Windows .msi 빌드 | Windows 머신 필요 |

---

## 9. 부록: 재현 단계

다음 세션 또는 다른 개발자가 Cycle B 결과를 그대로 재현하기 위한 절차.

**사전 조건**: Rust 1.93.1, Bun 1.3.9, macOS arm64 환경. Cycle A 결과물(`packages/tauri/` Phase 1 scaffolding + Cargo.toml tauri 2.9.5 핀) 적용 완료 상태.

---

**Step 1. logger.ts bundled 감지 코드 확인**

`packages/server/src/logger.ts`에서 아래 패턴이 존재하는지 확인:

```typescript
const isBundled = import.meta.url.startsWith('file:///$bunfs/');
const isDev = !isBundled && process.env.NODE_ENV !== 'production';
```

bundled 환경에서 `isDev`가 강제 false가 되어 transport 인자가 `undefined`로 전달되는 로직이 핵심이다.

---

**Step 2. compile-sidecar.ts --define 인자 확인**

`packages/server/scripts/compile-sidecar.ts`의 cmd 배열에 아래 인자들이 포함되어 있는지 확인:

```typescript
'--define', 'process.env.NODE_ENV="production"'
```

그리고 Bun.spawn 호출에 `env: { NODE_ENV: 'production' }` 옵션이 포함되어 있는지 확인.

---

**Step 3. lib.rs NODE_ENV env 확인**

`packages/tauri/src-tauri/src/lib.rs`의 sidecar spawn 코드에 `.env("NODE_ENV", "production")`이 포함되어 있는지 확인.

---

**Step 4. sidecar 재컴파일**

```bash
bun --filter @nexus/server compile
```

EXIT 0, 58.3 MB 전후 바이너리 생성 확인. 생성 경로: `packages/tauri/src-tauri/binaries/nexus-sidecar-aarch64-apple-darwin`

---

**Step 5. sidecar 단독 smoke**

```bash
packages/tauri/src-tauri/binaries/nexus-sidecar-aarch64-apple-darwin
```

별도 터미널에서:

```bash
curl http://localhost:<출력된 포트>/api/health
```

`{"status":"ok","timestamp":"...","hooks":{"active":0}}` 응답 확인. pino-pretty crash 없이 프로세스 생존 시 PASS.

---

**Step 6. dev orchestrator 확인**

`scripts/dev.ts` 193~208행에서:
- `cmd: ['bunx', 'tauri', 'dev']` 확인
- `cwd: 'packages/tauri'` 확인
- prefix `[tauri]` 확인
- `packages/electron` 참조 0건 확인

`packages/tauri/tauri.conf.json`에서 `beforeDevCommand: ""` 확인.

---

**Step 7. cargo build --release**

```bash
cd packages/tauri/src-tauri
cargo build --release
```

EXIT 0, 약 1m 24s, warnings 2건(미사용 import, dead code field)은 정상 — 기능 영향 없음.

---

**Step 8. tauri build (앱 번들 산출)**

```bash
cd packages/tauri
bunx tauri build
```

아래 두 산출물 생성 확인:
- `src-tauri/target/release/bundle/macos/Nexus Code.app` (64M)
- `src-tauri/target/release/bundle/dmg/Nexus Code_0.0.0_aarch64.dmg`

---

**Step 9. .app 구동 smoke**

```bash
open "src-tauri/target/release/bundle/macos/Nexus Code.app"
```

잠시 후 (`ps aux | grep nexus`) nexus-sidecar 프로세스 생존 확인. sidecar가 출력하는 포트 번호로:

```bash
curl http://localhost:<포트>/api/health
```

HTTP 200 + `{"status":"ok","timestamp":"...","hooks":{"active":0}}` 응답 확인. nexus-sidecar가 살아있으면 Cycle B PASS.

**예상 결과**: nexus-tauri(Rust shell)와 nexus-sidecar 모두 생존. pino-pretty crash 없음. `/api/health` HTTP 200 응답.

---

*문서 버전: Plan #8 Cycle B 완료, 2026-04-14. backlog 0, 부록 B 함정 5건 전원 완료. 다음: Cycle C(electron 폐기) → Cycle D(크로스플랫폼 + 장시간 SSE).*
