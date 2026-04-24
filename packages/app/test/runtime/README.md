# Runtime verification (Task 13)

`e2-terminal.runtime.test.ts` is an executable deterministic harness that verifies:

- 3 workspaces × 2 tabs lifecycle
- >=100 workspace/tab switches
- long-tail stdout stream behavior
- model-level PTY/host leak expectations after close
- xterm view reuse (no re-init across switches)
- scrollback drop metrics snapshots/evidence

## Run

```bash
bun run test:runtime-terminal
```

Evidence output is generated at:

- `packages/app/test/artifacts/runtime-terminal/latest.json`
- `packages/app/test/artifacts/runtime-terminal/latest.md`

## Full-app process/zombie check (manual pending)

The deterministic harness uses fake host/Xterm seams, so real `ps/pgrep` PTY zombie checks require a full Electron runtime pass:

```bash
bun run test:runtime-terminal:zombie-check
```
