## Native macOS Korean QA (Task 12)

- Manual checklist: `packages/app/test/manual-qa/korean-release-checklist.md`
- Evidence bundle: `packages/app/test/manual-qa/release-evidence/<RUN_ID>/`
- arm64 verdict: PASS | FAIL | PENDING
- x64 verdict: PASS | FAIL | PENDING
- Automated gate (`bun run test:ime-checklist`): PASS | FAIL
- Final release gate verdict: PASS | FAIL

> Release must remain blocked unless both arm64 + x64 manual verdicts are PASS.
