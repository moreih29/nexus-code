# Phase 2 Cycle A 실행 기록

> 작성일: 2026-04-14
> 대상: Plan #7 Phase 2 Cycle A 완료 기록 (영구 보관)
> 출처: Plan #7 Tasks 1–4 실행 결과 + tauri-migration-plan.md + tauri-phase1-verification.md + tauri-poc-report.md

---

## 1. 요약 (TL;DR)

Phase 2 Cycle A의 핵심 목표인 **Rust proc macro 패닉 해소 + macOS `.app` 번들 산출**을 모두 달성했다. 최종 적용 조합은 **Rust 1.93.1 + tauri 2.9.5**이며, `cargo build --release` 1m 27s / EXIT 0, `bunx tauri build` EXIT 0, 64M `.app` + `.dmg` 동시 산출로 Phase 2의 가장 큰 미결 항목이 해소되었다.

`.app` 구동(open 명령) 자체는 성공했으나 번들 내 sidecar를 직접 실행하면 `pino-pretty` transport 오류로 즉시 crash한다. 이는 POC 보고서 §5 주의사항 #6에서 예고한 항목이 실측으로 **확정**된 것이다. sidecar smoke는 PARTIAL 판정이며 **Cycle B**로 이관한다.

Electron 폐기는 **Cycle C**, 크로스플랫폼 빌드 검증은 **Cycle D**로 분리되어 있으며 본 기록에서 각 이관 항목의 경계를 명확히 정의한다.

---

## 2. 범위와 목표

### Cycle A 스코프

migration-plan.md (g)에서 정의한 Phase 2 분할 계획에서 Cycle A가 담당하는 범위:

| 항목 | 내용 |
|------|------|
| 주목표 | `tauri::generate_handler![]` proc macro 패닉 해소 |
| 부목표 | macOS `.app` 번들 산출 (.dmg 포함) |
| 선결 | `Cargo.toml` tauri 버전 핀, icons/ 리소스, sidecar 바이너리 배치 |
| 범위 밖 | dev orchestrator tauri dev 전환, electron 폐기, 크로스플랫폼, 30분+ SSE |

### Cycle B/C/D 경계

| Cycle | 담당 |
|-------|------|
| **B** | dev orchestrator tauri dev 전환 + 부록 B 함정 5건 (pino-pretty 번들 제외 포함) |
| **C** | `packages/electron` 폐기 + `dev-smoke-protocol.md` 갱신 |
| **D** | 크로스플랫폼 빌드 검증 (Linux webkit2gtk-4.1 + Windows .msi) + 30분+ SSE 장시간 안정성 |

---

## 3. 실행 단계별 결과

### 3.1 Task 결과 요약

| Task | 내용 | 판정 | 비고 |
|------|------|:----:|------|
| 1 | Cargo.toml tauri 버전 핀 | PASS | 2.10.1 → 2.9.5 |
| 2 | 선결 리소스 (icons, sidecar 바이너리) | PASS | icons 17파일, sidecar 58.3 MiB |
| 3 | 빌드 체인 (cargo check → cargo build → tauri build) | PASS | EXIT 0, 1m 27s |
| 4 | .app smoke (구동 확인 + 메타데이터) | PARTIAL | 앱 실행 성공, sidecar crash |

### 3.2 Task 1 — Cargo.toml 버전 핀

| 항목 | 수정 전 | 수정 후 |
|------|---------|---------|
| tauri | `version = "2"` (2.10.1까지 플로팅) | `version = "2.9.5"` (핀) |
| tauri-build | `version = "2"` | `version = "2"` 유지 |
| plugin-dialog | `version = "2"` | `version = "2"` 유지 |
| plugin-shell | `version = "2"` | `version = "2"` 유지 |

핀 근거: OpenCode `sst/opencode packages/desktop/src-tauri/Cargo.toml` 운영 버전. tauri-build 및 플러그인은 tauri 코어와 달리 플로팅 허용으로 판단하여 `"2"` 유지.

### 3.3 Task 2 — 선결 리소스

**icons/**

`bunx tauri icon` 단일 원본 이미지에서 자동 파생. 생성 파일 17개:

- 표준 크기: 32x32.png, 64x64.png, 128x128.png, 128x128@2x.png
- macOS: icon.icns, icon.png
- Windows: icon.ico, Square30x30Logo.png, Square44x44Logo.png, Square71x71Logo.png, Square89x89Logo.png, Square107x107Logo.png, Square142x142Logo.png, Square150x150Logo.png, Square284x284Logo.png, Square310x310Logo.png, StoreLogo.png

**sidecar 바이너리**

| 항목 | 수치 |
|------|------|
| 파일명 | `packages/tauri/src-tauri/binaries/nexus-sidecar-aarch64-apple-darwin` |
| 실측 크기 | 61,133,920 bytes = **58.3 MiB** |
| 빌드 방법 | `packages/server/scripts/compile-sidecar.ts` (Phase 1에서 구축) |

Phase 1 verification 기록의 "62,248,000 bytes (62.2 MB)"와 차이가 있다. 이는 Cycle A 시점의 재컴파일 결과이며 실측값을 우선한다.

### 3.4 Task 3 — 빌드 체인

| 단계 | 명령 | 결과 | 소요 / 비고 |
|------|------|:----:|-------------|
| Cargo.lock 생성 | `cargo generate-lockfile` | PASS | git 배제(.gitignore) |
| 정적 검증 | `cargo check` (Rust 1.93.1, tauri 2.9.5) | **PASS EXIT 0** | proc macro 패닉 재현 안됨. warnings 2건(미사용 import, dead code field) |
| 버전 조정 시도 | `cargo update` / rustup 1.92.0 fallback | **불필요** | tauri 2.9.5 핀만으로 해소 |
| 릴리즈 빌드 | `cargo build --release` | **PASS EXIT 0** | **1m 27s**, 394 crate, opt-level=s + lto + strip |
| 앱 번들 | `bunx tauri build` | **PASS EXIT 0** | .app + .dmg 동시 산출 |

cargo check warnings 2건(unused import, dead code field)은 기능에 영향 없으며 **Cycle B 정리 대상**으로 이관.

최종 확정 조합: **Rust 1.93.1 + tauri 2.9.5**

### 3.5 Task 4 — .app smoke

| 항목 | 결과 |
|------|------|
| .app 경로 | `packages/tauri/src-tauri/target/release/bundle/macos/Nexus Code.app` |
| .app 크기 | 64M |
| .dmg | `packages/tauri/src-tauri/target/release/bundle/dmg/Nexus Code_0.0.0_aarch64.dmg` |
| 실행 (`open`) | 성공 — nexus-tauri PID 생존, Gatekeeper 차단 없음 |
| sidecar smoke | **PARTIAL** — pino-pretty crash (§5.5 상세) |

---

## 4. proc macro 패닉 재현·해소 기록

### 4.1 패닉 원인 (POC 보고서에서 이관)

POC 보고서 §3 Track A에서 기록된 사항: `tauri::generate_handler![]` proc macro가 **Tauri 2.10.1 + Rust 1.93.1 조합**에서 `cargo check` 단계에서 패닉. Rust 빌드 394 crate가 해당 세션 내 완결 불가 판정을 받았다.

### 4.2 해소 방법

Cargo.toml의 tauri 의존성을 `"2"` (플로팅) → `"2.9.5"` (핀)으로 교체하는 단일 조치로 해소.

- `cargo update` 실행: 불필요
- Rust 1.92.0 다운그레이드: 불필요
- rustup 버전 변경: 불필요

**tauri 2.9.5 핀만으로 proc macro 패닉이 완전히 해소됨.**

### 4.3 OpenCode 참조 근거

버전 핀 값 `2.9.5`는 `sst/opencode packages/desktop/src-tauri/Cargo.toml` 운영 버전에서 직접 인용했다. OpenCode(142k stars)가 동일 Tauri v2 + sidecar 아키텍처를 운영 증명하고 있으며, 그 Cargo.toml 버전 조합이 proc macro 패닉 없이 안정적으로 동작한다는 사실이 핀 선택의 근거다.

### 4.4 검증 조합 확정

| 항목 | 값 |
|------|----|
| Rust | 1.93.1 |
| tauri | 2.9.5 |
| cargo check | PASS EXIT 0 |
| cargo build --release | PASS EXIT 0, 1m 27s, 394 crate |

---

## 5. .app 번들 메타데이터

### 5.1 번들 구조

```
target/release/bundle/macos/Nexus Code.app/Contents/
├── MacOS/
│   ├── nexus-tauri          (Rust shell, arm64)
│   └── nexus-sidecar        (Bun binary, arm64, 58.3 MiB)
├── Info.plist
└── Resources/
    └── (icons 등)
```

두 실행 파일 모두 arm64 아키텍처 확인.

### 5.2 Info.plist

| 키 | 값 |
|----|----|
| CFBundleIdentifier | com.nexus.code |
| CFBundleShortVersionString | 0.0.0 |
| LSMinimumSystemVersion | 10.13 |

### 5.3 코드 서명

| 항목 | 값 |
|------|----|
| 서명 방식 | adhoc + linker-signed |
| TeamIdentifier | 없음 (미서명) |
| Sealed Resources | none |
| 경고 | "code has no resources but signature indicates they must be present" — Tauri 기본 adhoc 서명 특성, 부차적 |

### 5.4 Quarantine

| 항목 | 값 |
|------|-----|
| com.apple.quarantine | 없음 (로컬 빌드 — 자동 부여 안됨) |
| com.apple.provenance | 존재 |

로컬 빌드이므로 Gatekeeper 차단 없이 `open` 성공.

### 5.5 sidecar crash 상세

번들 내 sidecar를 직접 실행하면 부팅 즉시 crash. 스택 트레이스:

```
error: unable to determine transport target for "pino-pretty"
  at fixTarget (/$bunfs/root/nexus-sidecar-aarch64-apple-darwin:2602:15)
  at transport (…:2582:33)
  at createLogger (…:5944:43)
Bun v1.3.9 (macOS arm64)
```

결과:
- `~/.nexus-code/logs/` 생성 안됨
- `/api/health` 호출 불가
- approval full roundtrip 미확인

이는 POC 보고서 §5 주의사항 #6("pino-pretty 등 dev 전용 로거 의존성의 `bun compile` 번들 제외 필요")이 실측으로 **확정**된 사항이다. Cycle A 목표(proc macro 해소 + .app 산출) 달성에는 영향 없으며 **Cycle B task #5**로 이관.

---

## 6. 미처리 항목 및 Cycle 이관

### 6.1 Cycle B 이관 — dev orchestrator 전환 + 부록 B 함정 5건

migration-plan.md (c) Phase 2 작업 #3, #5에 해당.

| 항목 | 내용 |
|------|------|
| pino-pretty 번들 제외 | sidecar crash의 직접 원인. `bun compile` 시 `pino-pretty` transport를 제외하거나 대체 로거 적용 필요. **Cycle B 최우선 task.** |
| sidecar 재빌드 파이프라인 | POC 부록 B.2에서 확인된 함정 — binaries/ 동기화 확인 |
| UI-sidecar 계약 정렬 | POC 부록 B.1에서 확인된 함정 |
| text_delta/text_chunk 중복 | POC 부록 B.8에서 확인된 함정 |
| sidecar 종료 Rust 핸들러 | POC 부록 B.3 OpenCode 패턴(`Arc<Mutex<Option<CommandChild>>>` + `RunEvent::Exit`) 적용 |
| dev orchestrator 전환 | `scripts/dev.ts` 재설계, `[electron]` → `[tauri]` prefix |
| cargo check warnings 2건 | unused import, dead code field 정리 |

### 6.2 Cycle C 이관 — Electron 폐기

migration-plan.md (c) Phase 2 작업 #4에 해당.

| 항목 | 내용 |
|------|------|
| packages/electron 폐기 | root `package.json` workspaces 제거 + 파일 삭제 |
| IPC 대체 | `select_folder` → `tauri-plugin-dialog` 대체 완성 확인 |
| dev-smoke-protocol.md | Tauri 기준으로 갱신 |

선결 요건: Cycle B dev orchestrator 전환 완료 후 진입.

### 6.3 Cycle D 이관 — 크로스플랫폼 + 장시간 SSE

migration-plan.md (c) Phase 2 작업 #6, #7에 해당.

| 항목 | 내용 |
|------|------|
| 30분+ SSE 장시간 안정성 | .app 산출 환경에서 실측 (Cycle A에서 .app 확보됨) |
| Linux webkit2gtk-4.1 빌드 | Linux VM 환경 필요 |
| Windows .msi 빌드 | Windows 머신 필요 |

POC 보고서 §6 T4("전용 측정 환경") 달성의 나머지 요건.

---

## 7. 부록: 재현 단계

다음 세션 또는 다른 개발자가 Cycle A 결과를 그대로 재현하기 위한 절차.

**사전 조건**: Rust 1.93.1, Bun 1.3.9, macOS arm64 환경. `packages/tauri/` Phase 1 scaffolding 적용 완료 상태.

---

**Step 1. Cargo.toml tauri 버전 핀 확인**

`packages/tauri/src-tauri/Cargo.toml`에서 tauri 의존성이 아래와 같이 핀되어 있는지 확인:

```toml
tauri = { version = "2.9.5", features = [] }
```

tauri-build, plugin-dialog, plugin-shell은 `"2"` 유지 확인.

---

**Step 2. sidecar 바이너리 컴파일**

```bash
bun --filter @nexus/server compile
```

`packages/tauri/src-tauri/binaries/nexus-sidecar-aarch64-apple-darwin` 생성 확인 (58.3 MiB 전후).

---

**Step 3. icons 생성**

원본 아이콘 이미지가 있다면:

```bash
cd packages/tauri
bunx tauri icon <원본_이미지_경로>
```

`src-tauri/icons/` 아래 17개 파일 생성 확인. 이미 생성되어 있으면 skip.

---

**Step 4. Cargo.lock 생성**

```bash
cd packages/tauri/src-tauri
cargo generate-lockfile
```

`Cargo.lock` 생성 확인 (.gitignore 등록으로 git 추적 제외).

---

**Step 5. cargo check**

```bash
cargo check
```

EXIT 0 확인. warnings 2건(unused import, dead code field)은 정상 — 기능 영향 없음. proc macro 패닉이 발생하면 Step 1의 버전 핀을 재확인.

---

**Step 6. cargo build --release**

```bash
cargo build --release
```

EXIT 0, 약 1m 27s, 394 crate 완료 확인.

---

**Step 7. tauri build (앱 번들 산출)**

```bash
cd packages/tauri
bunx tauri build
```

아래 두 산출물 생성 확인:
- `src-tauri/target/release/bundle/macos/Nexus Code.app` (64M)
- `src-tauri/target/release/bundle/dmg/Nexus Code_0.0.0_aarch64.dmg`

---

**Step 8. .app 구동 smoke**

```bash
open "src-tauri/target/release/bundle/macos/Nexus Code.app"
```

`ps aux | grep nexus-tauri`로 PID 확인. Gatekeeper 차단 없이 실행되면 PASS.

**예상 결과**: nexus-tauri(Rust shell) 프로세스 생존. WebView 창 표시. sidecar는 pino-pretty crash로 API 응답 없음 — 이 상태는 Cycle A의 정상 PARTIAL 결과이며, Cycle B에서 해소 예정.

---

*문서 버전: Plan #7 Cycle A 완료, 2026-04-14. pino-pretty 해소 후 Cycle B 완료 시 별도 기록.*
