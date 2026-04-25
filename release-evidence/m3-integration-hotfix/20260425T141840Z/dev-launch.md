# M3 integration hotfix dev launch verification

- Evidence timestamp (UTC): `20260425T141840Z`
- Scope: plan #16 H1(validate ESM) + H2(SidecarBridge swap) cut line integration verification
- Status: automated regression PASS; manual dev launch verification pending user run before PR merge

## Automated verification results

| Check | Result | Evidence |
| --- | --- | --- |
| `bun test` | PASS | `105 pass / 0 fail` across 32 files. Existing 103 tests passed and 2 composition-smoke integration tests were added. |
| `bun run typecheck` | PASS | shared + app `tsc --noEmit` completed. |
| `bun run build` | PASS | `electron-vite build` completed for main/preload/renderer. |
| `bun run lint` | PASS | `eslint "src/renderer/**/*.{ts,tsx}"` completed. |
| `bun run gen:contracts` stability | PASS | Two runs produced identical generated-contract SHA-256: `f9907a1b852a6e3f349907bad5acf81d6a3e485e8cf6c2af86d202db8574411b`. |
| `cd sidecar && go test ./...` | PASS | `cmd/nexus-sidecar` and `internal/wsx` ok; `internal/contracts` has no test files. |
| `cd sidecar && go build ./...` | PASS | completed with no output/errors. |
| Composition sidecar smoke | PASS | `packages/app/test/integration/sidecar-lifecycle/composition-smoke.test.ts` ran with actual sidecar binary: lifecycle manager + `SidecarBridge` workspace-open spawn/handshake, sidecar ready stderr log, and missing-binary fallback. |

## Composition test review

- Reviewed: `packages/app/src/main/electron-app-composition.test.ts`
- Finding: H2 test verifies `composeElectronAppServices()` injects a `SidecarBridge` instance, but it does not exercise workspace-open sidecar spawn/handshake or token-dependent authentication.
- Action: Added `packages/app/test/integration/sidecar-lifecycle/composition-smoke.test.ts` to cover a composition-equivalent `OpenSessionSidecarLifecycleManager + SidecarBridge` path with actual sidecar binary.
- Token evidence: the smoke test completes READY + WebSocket handshake with the actual sidecar binary and asserts the sidecar stderr ready log (`nexus-sidecar ready pid=N workspaceId=...`). This path requires `SidecarBridge` to set `NEXUS_SIDECAR_TOKEN` in child env and reuse the generated token in the WebSocket auth header; otherwise the sidecar exits with `FATAL: NEXUS_SIDECAR_TOKEN not set` or rejects the handshake.
- Missing-binary evidence: the smoke test verifies missing binary returns no running record (`pid -1` unavailable event path) and does not spawn.

## Manual dev launch verification procedure

Run once on the user PC immediately before PR merge.

1. Build sidecar binary:
   ```sh
   cd sidecar && go build -o bin/nexus-sidecar ./cmd/nexus-sidecar
   ```
2. Launch Electron app from repository root:
   ```sh
   bun run dev
   ```
3. Open one workspace via Electron menu: **Open Folder**.
4. Verify manually:
   - Renderer console (DevTools): `require is not defined` errors = 0
   - Terminal stdout/stderr: `FATAL: NEXUS_SIDECAR_TOKEN not set` occurrences = 0
   - Sidecar handshake stderr log: `nexus-sidecar ready pid=N workspaceId=...` occurrences >= 1
   - `SidecarProcessRuntime exited (exitCode=78)` occurrences = 0
   - Workspace shell works normally: sidebar click works and terminal tab works
5. Quit normally with `Cmd+Q`, then confirm no sidecar process remains:
   ```sh
   ps aux | grep nexus-sidecar
   ```
   Expected: 0 live `nexus-sidecar` processes (ignore the `grep` command itself if shown).

## Manual verification result area

- Date/time (UTC): _pending_
- Operator: _pending_
- Command/result notes:
  - `cd sidecar && go build -o bin/nexus-sidecar ./cmd/nexus-sidecar`: _pending_
  - `bun run dev`: _pending_
  - Open Folder workspace path: _pending_
  - Renderer console `require is not defined`: _pending_
  - Terminal `FATAL: NEXUS_SIDECAR_TOKEN not set`: _pending_
  - Sidecar ready log count: _pending_
  - `SidecarProcessRuntime exited (exitCode=78)`: _pending_
  - Workspace shell/sidebar/terminal behavior: _pending_
  - Post-`Cmd+Q` process check: _pending_
- Final manual verdict: _pending_
