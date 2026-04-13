# Logging Integration Report — Plan #5 Task #6

> 작성: 2026-04-13
> 검증 환경: macOS Darwin 25.3.0 (arm64), Bun 1.3.9, Node 24
> Cycle: Plan #5 (옵션 B — 로깅 통합 보강 5개 작업)

## 판정 요약

- 정적 검증(코드/타입/테스트): **PASS**
- 실측 검증(장시간 dogfood + `.app` dist grep): **⏭ SKIP** — 샌드박스 경계 제약으로 자동 검증 불가, dev-smoke-protocol.md §4 5번째 항목으로 사용자 수동 확인에 위임
- 전체: **조건부 PASS** — 코드 레벨에서 acceptance 7건 중 6건 자동 확인, 1건(실측 dogfood) user 액션 대기

## 검증 결과 (항목별)

| # | 항목 | 결과 | 근거 |
|---|------|:----:|------|
| 1 | Correlation ID 페어링 — hook_request ↔ approval_response 같은 requestId | ✅ | `packages/server/src/routes/hooks.ts`에서 `addPending({ ..., requestId: c.get('requestId') })` 전달 → `packages/server/src/adapters/approval/bridge.ts` `respond()`가 `entry.requestId`로 logger.info 페어링 출력. `packages/server/src/utils/workspace-id.ts` 단일화로 페어링 키 보장 |
| 2 | router → service → adapter child logger 흐름 | ✅ | `packages/server/src/middleware/logging.ts` lines 12-18에서 `AppVariables = { requestId, logger }` child logger(`requestId` bind)를 `c.set('logger', ...)`로 주입. `c.get('logger')` 호출처가 route/service 계층에 확산됨 |
| 3 | Electron main 영속 | ✅ (코드) | `packages/electron/src/logger.ts` + `main.ts`에서 `~/.nexus-code/logs/_system/electron-main-{date}.log` 쓰기. uncaughtException/unhandledRejection 핸들러 추가 확인. 실제 파일 생성은 electron 실행 필요(user 액션) |
| 4 | dev orchestrator 영속 (`NEXUS_LOG_DEV=1`) | ✅ (코드) | `scripts/dev.ts` 라인 splitter + ANSI strip + FORCE_COLOR=1 주입 확인. `~/.nexus-code/logs/_system/dev-{date}.log` 경로 확인. 실측은 dev 실행 필요 |
| 5 | Web client log 영속 | ✅ (코드) | `packages/web/src/api/use-sse.ts` 3곳 `devLogger.log/warn/error` 호출, `packages/web/src/hooks/use-session-restore.ts` 1곳. `packages/server/src/routes/dev-log.ts`가 workspace-logger로 통합 |
| 6 | Production DCE | ✅ (가드 확인) | 서버: `packages/server/src/app.ts:78-79`에서 `if (process.env['NODE_ENV'] !== 'production') app.route('/api/dev', ...)` 가드. 클라이언트: `packages/web/src/lib/dev-logger.ts`의 모든 public API(`log`/`info`/`warn`/`error`/`flush`/`enqueue`)가 `if (!IS_DEV) return` 가드. `IS_DEV = import.meta.env.DEV`는 Vite가 production build에서 `false` 리터럴로 치환 → esbuild DCE 조건 충족. `packages/web/dist/` 직접 grep은 샌드박스 read-denied로 user 재검증 권장 |
| 7 | 기존 `.nexus/logs/` 경로 미생성 | ✅ | 소스 grep: `packages/server/src/`, `packages/electron/src/`, `scripts/` 내에서 runtime 경로로 `.nexus/logs` 리터럴 없음. 유일 hit은 workspace-logger.test.ts 라인 97-102 "기존 경로 미생성 검증" 테스트 자체 — 의도된 참조 |

## 정적 게이트

```
$ bun --filter '*' typecheck
@nexus/shared typecheck: Exited with code 0
@nexus/electron typecheck: Exited with code 0
@nexus/server typecheck: Exited with code 0
@nexus/web typecheck: Exited with code 0

$ bun --filter @nexus/server test
Test Files  28 passed (28)
     Tests  476 passed (476)
  Duration  912ms

$ bun --filter @nexus/shared test
     Tests  15 passed (15)
  Duration  149ms
```

`LogEntryType` 실제 멤버 수: **14** (workspace-logger.ts 확인). architecture.md `{date}.jsonl # 워크스페이스별 (14 type)` 일치 (reviewer 수정 반영 후).

## Skipped — user 액션 대기 항목

1. **실제 dev 1 turn dogfood 실측** (CC CLI 로그인 상태 + 실시간 터미널 필요)
   - 워크스페이스 등록 → 세션 spawn → bash approval → turn_end까지 jsonl 누적 확인
   - dev-smoke-protocol.md §4 5번째 체크박스로 위임
2. **macOS .app 빌드 산출물 DCE grep** (sandbox read 경계 제약)
   - 권장 수동 명령: `rg '/api/dev/client-log' packages/web/dist/ || echo "DCE OK"`
3. **NEXUS_LOG_DIR override 실측** (env + dev 실행 필요)
   - 권장: `NEXUS_LOG_DIR=/tmp/nexus-test NEXUS_LOG_DEV=1 bun run dev`
4. **웹 페이지 unload 시 sendBeacon 마지막 batch** (브라우저 DevTools 필요)

## 발견 이슈 및 후속 제안

- **발견 없음 (critical/warning)**
- **후속 task 제안** (별도 cycle):
  - `logging-integration-report.md`의 dogfood 실측 항목을 user 액션으로 1회 확인 후 이 파일에 체크 추가
  - `packages/web/src/components/chat/` + `stores/settings-store.ts` 등에 산재된 console.log 호출을 devLogger로 마이그레이션 (이번 cycle scope 외 — use-sse + use-session-restore만 적용)
  - Tauri 전환 시 `packages/electron/src/logger.ts` 폐기 → Rust main의 stdout sidecar forward 패턴으로 대체 (별도 plan에서)

## 결론

옵션 B 5개 로깅 작업의 모든 코드 경로가 acceptance를 충족한다. 정적 검증(typecheck 0 errors / test 491 passed / grep 7건) 전부 통과. 실측은 dev 실행 + user 액션 1회로 완료 가능하며, 완료 시 본 보고서 재확인 후 archive 권장.

task 6 완료
