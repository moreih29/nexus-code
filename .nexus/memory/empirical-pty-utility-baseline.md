# empirical: PTY utility latency baseline

Date: 2026-05-14

## Environment

- Machine: `MacBookPro18,4`, Apple M1 Max.
- OS: macOS 26.3 build 25D125; Darwin 25.3.0 arm64 (`ihMacPro.local`).
- Shell: `/bin/zsh`; `zsh 5.9 (arm-apple-darwin24.2.0)`.
- Repo/branch: `/Users/kih/workspaces/areas/nexus-code`, `feat/ssh-remote-workspace`.
- Utility path: Electron `utilityProcess` running current `out/main/pty-host.js`, connected with real `MessageChannelMain`, using current `node-pty` utility host behavior.

## Method

Command: `./node_modules/.bin/electron /tmp/nexus-pty-utility-latency.cjs` (temporary helper, removed after capture).

For each of 5 runs, the helper spawned a fresh `/bin/zsh` PTY through the utility host, waited for prompt quiet, sent `Ctrl+U`, then sent 120 serial `a` keystrokes. The first 20 were warmup; 100 samples were measured. Latency is `performance.now()` immediately before posting the utility `write` message to main's MessagePort endpoint until main received the corresponding utility `data` MessagePort event containing the echo. Percentiles use nearest-rank.

## Raw runs

| run | samples | p50 ms | p99 ms | mean ms | min ms | max ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 100 | 0.099 | 0.152 | 0.102 | 0.069 | 0.152 |
| 2 | 100 | 0.172 | 0.251 | 0.175 | 0.120 | 0.270 |
| 3 | 100 | 0.154 | 0.306 | 0.168 | 0.136 | 0.506 |
| 4 | 100 | 0.117 | 0.201 | 0.131 | 0.102 | 0.278 |
| 5 | 100 | 0.150 | 0.462 | 0.159 | 0.109 | 0.464 |

Average across the 5 raw runs: p50 `0.138 ms`, p99 `0.274 ms`, mean `0.147 ms`, min `0.107 ms`, max `0.334 ms`.

## Limitations

This is a utility-path host baseline, not a full renderer/xterm.js visual commit measurement. It includes Electron main ↔ utility MessagePort, node-pty, zsh, and echo delivery back to main, but excludes renderer IPC scheduling and xterm.js buffer write cost. Use this as the frozen current-utility anchor only if the later Go-path benchmark measures the same endpoint; otherwise rerun both paths with a renderer/xterm harness before comparing absolute p50/p99 deltas.
