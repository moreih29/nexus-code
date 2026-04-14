# Tauri Migration Plan

Nexus Code의 데스크톱 셸을 Electron에서 Tauri 2.x로 전환하는 실행 계획.

---

## (a) 결정 근거

2026-04-13, Plan #5 Issue #1에서 **옵션 A — Tauri 전면 전환** 강행이 user에 의해 결정되었다. architect/strategist의 일치 권고(옵션 C — trigger 기반 조건부 전환)는 기각되었다. Plan #6 I4(Electron 잠정 유지 + trigger 2/4 충족 시 재평가) 역시 본 결정으로 supersede된다.

POC 근거: `.nexus/memory/tauri-poc-report.md` — blocker 0건. 부록 B.1~B.4에서 UI ↔ sidecar ↔ CC 실 왕복(approval full roundtrip 포함) 검증 완료. "sidecar Bun 호환성"과 "WKWebView SSE 실동작"이라는 두 핵심 불확실성이 해소되어, 잔여 미결 항목은 Rust `tauri::generate_handler![]` proc macro 패닉 해소 및 `.app` 번들 산출 한 건으로 축소되었다.

---

## (b) Phase 1 Scope (본 cycle — sandbox 가능)

본 레포 통합 준비 작업. Rust toolchain 없이 실행 가능한 범위만 포함한다.

| # | 작업 | 상태 |
|---|------|------|
| 1 | tauri-migration-plan.md 신설 + philosophy/architecture 갱신 | 이 task |
| 2 | server Bun 호환 (Bun.serve + bun:sqlite × 4) | task #2 |
| 3 | compile-sidecar.ts + platform triple 매핑 | task #3 |
| 4 | packages/tauri scaffolding (src-tauri + IPC) | task #4 |
| 5 | 부록 B Phase 1 3건 (SSE heartbeat, CC binary env, workspace resolution) | task #5 |
| 6 | 통합 정적 검증 | task #6 |

---

## (c) Phase 2 Scope (별도 cycle — 전용 환경 필요)

Rust toolchain 및 macOS 빌드 환경이 준비된 전용 측정 환경에서 진행한다.

| # | 작업 | 선결 요건 |
|---|------|-----------|
| 1 | Rust `tauri::generate_handler![]` proc macro 패닉 해소 | Cargo.toml 버전 핀 조정(OpenCode `packages/desktop/src-tauri/Cargo.toml` 참조) 또는 `cargo update` — **Cycle A 완료** (tauri 2.9.5 핀, Rust 1.92 다운그레이드 불필요) |
| 2 | macOS `.app` 번들 산출 | Rust toolchain + `cargo build` 성공 — **Cycle A 완료** (64M, DMG 보너스) |
| 3 | dev orchestrator tauri dev 전환 (`scripts/dev.ts` 재설계, `[electron]` → `[tauri]` prefix) | `.app` 번들 산출 성공 |
| 4 | `packages/electron` 폐기 (root `package.json` workspaces 제거 + 파일 삭제 + IPC `select_folder` → `tauri-plugin-dialog` 대체) | dev orchestrator 전환 후 |
| 5 | 부록 B 함정 Phase 2 5건 (sidecar 재빌드 파이프라인, UI-sidecar 계약 정렬, text_delta/text_chunk 중복, sidecar 종료 Rust 핸들러, pino-pretty 번들 제외) | — pino-pretty 번들 제외 이슈 **확정** (Cycle A smoke에서 sidecar crash로 재현됨) |
| 6 | 30분+ SSE 장시간 안정성 실측 | `.app` 산출 후 |
| 7 | Linux webkit2gtk-4.1 + Windows `.msi` 빌드 검증 | Linux VM + Windows 머신 |

---

## (d) 선결 필수 체크리스트 (Phase 2 시작 전)

- [x] `Cargo.toml`에 tauri 2.9.5 핀 (OpenCode `packages/desktop/src-tauri/Cargo.toml` 참조) — Cycle A 완료
- [x] Rust 1.93.1 유지로 충분 (tauri 2.9.5 조합에서 proc macro 패닉 재현 안됨) — Cycle A 완료
- [ ] 전용 측정 환경 확보 (macOS 빌드 + Linux VM + Windows 머신)
- [ ] `CLAUDE_BIN_PATH` env 배포 전략 (packaging 시 바이너리 포함 vs PATH 탐색)

---

## (e) User 실측 위임 항목 (Phase 1 검증 skip)

아래 항목은 Rust toolchain 및 전용 환경이 필요하므로 Phase 1 정적 검증 범위에서 제외하고 user에게 위임한다.

1. `cargo check` / `cargo build` 통과 — ✅ Cycle A 완료 (Rust 1.93.1 + tauri 2.9.5)
2. `bun --filter @nexus/tauri dev` 실행 (Tauri dev mode 창 띄움)
3. `bun --filter @nexus/server compile` 실행 후 `binaries/nexus-sidecar-<triple>` 생성 확인 — ✅ Cycle A 완료 (58.3 MiB)
4. 30분+ SSE 장시간 안정성
5. macOS `.app` 번들 실제 실행 + approval full roundtrip — ⚠️ Cycle A 부분 완료 — .app 창 생성은 확인, approval 왕복은 Cycle B 의존 (sidecar pino-pretty crash 해결 후)
6. Linux webkit2gtk / Windows `.msi` 빌드

---

## (f) 파일 레퍼런스

| 파일 | 설명 |
|------|------|
| `.nexus/memory/tauri-poc-report.md` | POC 부록 B 함정 8개 원본 |
| `.nexus/context/philosophy.md` | Tauri 런타임 재평가 Trigger [ARCHIVED] |
| `.nexus/context/architecture.md` | 5 패키지 구조 (이번 cycle 반영) |
| `.nexus/memory/tauri-migration-plan.md` | 본 문서 |
| `packages/tauri/src-tauri/` | Phase 1 scaffolding 산출물 (task #4) |
| `packages/server/scripts/compile-sidecar.ts` | sidecar compile 스크립트 (task #3) |

---

## (g) 커밋 순서 (Phase 1 — 단일 cycle commit)

Plan #5 cycle 70 패턴 차용 — 단일 commit에 모든 Phase 1 변경 포함.

커밋 메시지:

```
feat(tauri): Phase 1 — sidecar Bun compat + packages/tauri scaffolding + Phase 1 pitfalls
```

Phase 2는 별도 cycle들로 분할한다:

- **Cycle A**: Rust 툴체인 정비 (proc macro 해소 + `.app` 번들) — **완료 (2026-04-14, commit 예정)**
- **Cycle B**: dev orchestrator tauri dev 전환 + 부록 B 함정 5건 적용 (**pino-pretty 번들 제외 우선 착수**) — 잔여
- **Cycle C**: `packages/electron` 폐기 + `dev-smoke-protocol.md` 갱신
- **Cycle D**: 크로스플랫폼 빌드 검증 (Linux/Windows) + 장시간 SSE

---

*문서 버전: Phase 2 Cycle A 완료 반영, 2026-04-14. Cycle B 진입 시 pino-pretty 번들 제외 우선 착수.*
