# PTY M3 cleanup follow-up

Recorded on 2026-05-14 as the M3 anchor for the Go-agent PTY migration. Discoverable query: `pty m3 cleanup`.

## Trigger

Start this cleanup only after M2 soak validates the Go path:

1. SSH workspaces remain always-on Go-agent PTY with no blocker regressions.
2. Local workspaces can run with `experimental.ptyViaAgent=true` for at least one release/soak window.
3. The rollback need for `experimental.ptyViaAgent=false` is below the agreed threshold or explicitly accepted by the product owner.
4. T11-style latency gate still passes against the frozen utility baseline: Δp50 ≤ +5ms and Δp99 ≤ +10ms.
5. T10/T12-style round-trip coverage still passes for local-agent and SSH-agent PTY paths.

If any of these fail, do not delete the utility path; reopen the relevant PTY migration issue instead.

## Delete / simplify in M3

- Remove the local-PTY utility process path:
  - `src/utility/pty-host/flow-control.ts`
  - `src/utility/pty-host/index.ts`
  - `src/utility/pty-host/pty-manager.ts`
  - `src/utility/pty-host/terminal-recorder.ts` after confirming the main-side recorder fully owns the remaining path
  - `src/utility/pty-host/zsh-init-dir.ts` if no other utility entry still imports it
- Remove PTY utility process boot/wiring from the main process. Reconfirm exact paths at M3; current references include the PTY host handle passed into `registerPtyChannel` and utility-process entry wiring.
- Simplify `src/main/features/pty/ipc.ts`:
  - remove `PtyRoute = "utility" | "agent"`
  - remove `routeBySession`, `workspaceIdByTabId`, utility event forwarding, and utility `ack` compatibility (`charCount`)
  - route all PTY calls to the agent host with explicit `workspaceId`
  - keep renderer ack as the source of credit and continue forwarding `bytesConsumed` to Go without synthetic main acks
- Remove `experimental.ptyViaAgent` from:
  - `src/shared/types/app-state.ts`
  - state defaults/migrations if any are added before M3
  - tests and fixtures that assert local utility fallback
- Rewrite or delete utility-only tests:
  - `tests/unit/utility/pty/*`
  - PTY channel tests whose only purpose is utility-vs-agent route selection
  - utility recorder parity tests after the main recorder has direct coverage

## Do not delete in this cleanup

- Do **not** remove the `node-pty` npm dependency solely because PTY runtime moved to Go. `src/main/infra/agent/ssh-auth-pty.ts` still uses `node-pty` for interactive SSH authentication/control-master bootstrap, and integration fixtures use the same dependency.
- Do **not** remove SSH auth PTY tests or fixtures unless SSH authentication is migrated separately.
- Do **not** replace the discrete PTY RPC contract with a stream/sub-channel as part of cleanup; that requires a fresh latency/backpressure decision if needed.

## Reconfirm before editing

Run these searches before M3 deletion because paths may move during M2:

```sh
grep -R "ptyViaAgent\|src/utility/pty-host\|startConfiguredPtyHost\|PtyRoute\|charCount" -n src tests package.json
grep -R "require(\"node-pty\")\|from \"node-pty\"" -n src tests package.json
```

Expected post-cleanup verification:

```sh
go test ./...
bun run typecheck
bun test tests/unit/main/pty tests/unit/renderer/services/terminal-services.test.ts tests/integration/agent/pty
NEXUS_RUN_SSH_PTY_FIXTURE=1 bun test tests/integration/ssh/
```

Current repository note: full `biome check .` has unrelated pre-existing diagnostics outside the PTY M3 scope, so use targeted Biome checks until the repo-wide lint baseline is cleaned up or updated.
