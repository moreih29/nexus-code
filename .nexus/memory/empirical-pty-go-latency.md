# empirical: PTY Go path latency benchmark

Date: 2026-05-14

## Environment

- Machine: `MacBookPro18,4`, Apple M1 Max.
- OS: macOS 26.3 build 25D125; Darwin 25.3.0 arm64 (`ihMacPro.local`).
- Shell: `/bin/zsh`; `zsh 5.9 (arm64-apple-darwin25.0)`.
- Repo/branch: `/Users/kih/workspaces/areas/nexus-code`, `feat/ssh-remote-workspace`.
- Go: `go version go1.24.3 darwin/arm64`.
- Electron: `v41.5.0`.
- Go path: Electron main-process helper using current `AgentPtyHost`, `createLocalChannel`/`createReconnectingProcessChannel`, a Go agent binary built from `./cmd/agent`, `creack/pty`, and `/bin/zsh`.

## Method

Commands:

```sh
go build -o /tmp/nexus-agent-latency ./cmd/agent
bun build /tmp/nexus-pty-go-latency.ts --target=node --format=cjs --outfile=/tmp/nexus-pty-go-latency.cjs
./node_modules/.bin/electron /tmp/nexus-pty-go-latency.cjs | tee /tmp/nexus-pty-go-latency-electron.json
```

For each of 5 runs, the helper reused one local Go agent process but spawned a fresh `/bin/zsh` PTY through the Go agent path, waited for prompt quiet, sent `Ctrl+U`, then sent 120 serial `a` keystrokes. The first 20 were warmup; 100 samples were measured. Latency is `performance.now()` immediately before Electron main calls `AgentPtyHost.call("write")` until `AgentPtyHost` receives and decodes the corresponding `pty.data` event containing the echo. Percentiles use nearest-rank.

## Raw runs

| run | samples | p50 ms | p99 ms | mean ms | min ms | max ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 100 | 0.078 | 0.145 | 0.087 | 0.058 | 0.462 |
| 2 | 100 | 0.086 | 0.131 | 0.090 | 0.063 | 0.323 |
| 3 | 100 | 0.071 | 0.121 | 0.074 | 0.039 | 0.268 |
| 4 | 100 | 0.088 | 0.309 | 0.099 | 0.059 | 0.540 |
| 5 | 100 | 0.092 | 0.170 | 0.095 | 0.053 | 0.176 |

Average across the 5 raw runs: p50 `0.083 ms`, p99 `0.175 ms`, mean `0.089 ms`, min `0.055 ms`, max `0.354 ms`.

## Baseline comparison

T2 utility host-level baseline average: p50 `0.138 ms`, p99 `0.274 ms`, mean `0.147 ms`, min `0.107 ms`, max `0.334 ms`.

| metric | T2 utility baseline ms | Go path ms | Δ ms |
|---|---:|---:|---:|
| p50 | 0.138 | 0.083 | -0.055 |
| p99 | 0.274 | 0.175 | -0.099 |

PASS: Δp50 `-0.055 ms` is within the `≤ +5 ms` threshold, and Δp99 `-0.099 ms` is within the `≤ +10 ms` threshold.

## Limitations

This is a host-level benchmark, not a full renderer/xterm.js visual commit measurement. It includes Electron main → TypeScript agent host/channel → Go agent stdio/NDJSON → `creack/pty` → zsh echo → Go `pty.data` → TypeScript host decode, but excludes renderer IPC scheduling and xterm.js buffer/write cost.

The endpoint is intentionally analogous but not byte-identical to the T2 utility baseline: T2 measured before posting a utility `write` MessagePort message until main received a utility `data` MessagePort event; this run measured before `AgentPtyHost.call("write")` until the main-side decoded host event. The current Go path also does not apply the utility host's zsh `ZDOTDIR` wrapper; the benchmark used the production agent spawn shape (`env: {}` in the PTY spawn params, with the Go service inheriting the agent process environment).
