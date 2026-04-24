# Manual QA Evidence — Task 12 (Signed macOS Korean Release Gate)

> Template only. Copy into `release-evidence/<RUN_ID>/evidence.md` and fill with real results.

## Run metadata

- Run ID:
- Date (UTC):
- Tester:
- Build ID / artifact:
- Git commit:
- Checklist source: `packages/app/test/manual-qa/korean-release-checklist.md`

## Host matrix

| Arch | Device/VM | macOS version | App path | Result |
| --- | --- | --- | --- | --- |
| arm64 |  |  |  | PENDING |
| x64 |  |  |  | PENDING |

## Check matrix (must PASS on both)

| Check ID | Description | arm64 | x64 | Evidence files | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Signed app Dock launch + trust chain | PENDING | PENDING | `arm64/S1-*`, `x64/S1-*` | |
| E1 | PATH / brew / node / mise sanity | PENDING | PENDING | `arm64/E1-*`, `x64/E1-*` | |
| E2 | Login env (`PATH`, `LANG`, `NVM_DIR`) | PENDING | PENDING | `arm64/E2-*`, `x64/E2-*` | |
| K0 | Korean 2-beol IME precondition | PENDING | PENDING | `arm64/K0-*`, `x64/K0-*` | |
| K1 | Composition cursor alignment | PENDING | PENDING | `arm64/K1-*`, `x64/K1-*` | |
| K2 | Enter double-submit guard | PENDING | PENDING | `arm64/K2-*`, `x64/K2-*` | |
| K3 | Hangul width (`ㅎ`, `가`, Hangul) | PENDING | PENDING | `arm64/K3-*`, `x64/K3-*` | |
| K4 | NFC path normalization | PENDING | PENDING | `arm64/K4-*`, `x64/K4-*` | |
| K5 | No dropped chars during composition | PENDING | PENDING | `arm64/K5-*`, `x64/K5-*` | |
| K6 | Input→echo→paint latency `<16ms` avg | PENDING | PENDING | `arm64/K6-*`, `x64/K6-*`, `latency-samples.csv` | |
| K7 | Font stack has D2Coding + Noto Sans KR | PENDING | PENDING | `arm64/K7-*`, `x64/K7-*` | |
| T1 | Scrollback FIFO boundary behavior | PENDING | PENDING | `arm64/T1-*`, `x64/T1-*` | |
| T2 | Copy-on-select + Cmd/Ctrl+C/V | PENDING | PENDING | `arm64/T2-*`, `x64/T2-*` | |
| T3 | Ctrl/Cmd+F search boundary | PENDING | PENDING | `arm64/T3-*`, `x64/T3-*` | |

## Exceptions / waivers (must be approved explicitly)

- None.

## Final verdict

- arm64 verdict: PASS | FAIL | PENDING
- x64 verdict: PASS | FAIL | PENDING
- Release verdict: PASS | FAIL
- Blocking reasons (if FAIL/PENDING):
