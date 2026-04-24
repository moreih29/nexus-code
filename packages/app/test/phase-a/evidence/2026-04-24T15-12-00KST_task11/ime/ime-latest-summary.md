# IME Checklist Release Gate Evidence

- Generated at: 2026-04-24T05:44:40.920Z
- Harness mode: deterministic seam checks (non-native IME simulation)
- Native manual QA required: **yes**

## Checklist status

| Item | Status | Notes |
| --- | --- | --- |
| #1 | PASS | Overlay render matched deterministic cursor seam anchor transform + minHeight. |
| #2 | PASS | Composing Enter was swallowed; post-composition Enter remained forwardable as submit/newline. |
| #3 | PASS | Unicode11 cell-width seam returned expected double-width for Hangul characters. |
| #4 | PASS | Referenced existing NFC regression test in src/main/workspace-persistence.test.ts. |
| #5 | PASS | Composition buffer retained the full update stream and suppressed duplicate PTY echo once. |
| #6 | PASS | Deterministic seam harness measured input→PTY echo→paint path. Native macOS IME measurement remains manual QA. |
| #7 | PASS | Default terminal font-family keeps D2Coding first and Noto Sans KR as immediate fallback. |

## Manual native IME blocker

This release gate does **not** claim full macOS native IME automation. Signed-app manual QA remains required before release.
