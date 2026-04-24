# Korean IME / Rendering Release Gate (Task 11)

Run:

```bash
bun run test:ime-checklist
```

## Checklist coverage map

- #1 Composition cursor overlay alignment → `test/ime-checklist/ime-release-gate.test.ts`
- #2 Enter during composition (double-Enter guard) → `test/ime-checklist/ime-release-gate.test.ts`
- #3 Hangul width expectations (`ㅎ`, `가`, general Hangul) → `test/ime-checklist/ime-release-gate.test.ts`
- #4 NFC path normalization → **referenced existing test** `src/main/workspace-persistence.test.ts` (no duplicate)
- #5 No dropped chars during composition buffering → `test/ime-checklist/ime-release-gate.test.ts`
- #6 Input→PTY echo→paint latency scaffold (<16ms average) → `test/ime-checklist/ime-release-gate.test.ts` (deterministic seam harness)
- #7 Default font stack includes D2Coding + Noto Sans KR → `test/ime-checklist/ime-release-gate.test.ts`

## Artifact outputs

Each run writes evidence files to `test/ime-checklist/artifacts/`:

- `latest-evidence.json`
- `latest-summary.md`
- `screenshots/manual-native-ime-required.md`

## Release policy

Passing this automated gate is **required but not sufficient**.

Release is still blocked until signed-app native manual QA passes on both arm64 and x64:

- Checklist: `test/manual-qa/korean-release-checklist.md`
- Evidence bundle root: `test/manual-qa/release-evidence/`
