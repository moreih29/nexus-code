# Integration Tests

Run with:

```
bun run test:integration
```

## Automated scenarios (this directory)

| File | What it verifies |
|------|-----------------|
| `ipc-roundtrip.test.ts` | Fake ipcMain harness: `register` → `call` → zod validation → `broadcast` → fake listener. No Electron process required. |
| `storage-restart.test.ts` | Real temp-dir SQLite files: `GlobalStorage` + `StateService` + `WorkspaceStorage` persist data across close/re-open cycles. |
| `workspace-lifecycle.test.ts` | `WorkspaceManager` + all three storage layers combined: `create` → `list` → `update` (state.db + workspace.json + `changed` broadcast) → `remove` (`removed` broadcast with `{id}`) → directory stays on disk (M0 spec). |

## Deferred to T13 (manual 1-hour session)

The following scenario requires a live Electron window and cannot run in a
headless bun:test environment:

**Monaco + xterm integration** — verify that:
1. Opening a workspace loads the Monaco editor pane.
2. Switching to a terminal tab spawns a PTY via the pty channel and xterm.js
   renders output.
3. LSP diagnostics from the `lsp.diagnostics` listen channel appear as
   squiggles inside Monaco.
4. Closing the window closes all PTY + LSP child processes cleanly.

Reason for deferral: Monaco and xterm.js require a real DOM with canvas/WebGL
context. jsdom does not support either. A Playwright + Electron setup adds
significant CI overhead that is out of scope for M0 solo development.
