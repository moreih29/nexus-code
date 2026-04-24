# Runtime Verification Evidence — Task 13

- Generated at: 2026-04-24T06:31:59.713Z
- Workspaces/Tabs: 3 workspaces × 2 tabs
- Workspace switches: 120
- Stall threshold: 100ms
- Stalled iterations: 0
- Long-tail dropped bytes: 31768

## PTY Count Snapshots
- after-open: expected 6, observed 6
- after-gamma-primary-user-close: expected 5, observed 5
- after-ws-alpha-close: expected 3, observed 3
- after-ws-beta-close: expected 1, observed 1
- after-ws-gamma-close: expected 0, observed 0

## Full-app Zombie Check
- Status: pending-full-app-runtime
- Reason: Deterministic harness runs on fake host/Xterm seams; real ps/pgrep zombie checks require full Electron runtime.
- Hook command: bun run test:runtime-terminal:zombie-check
