# @nexus/app

E1 workspace-shell scaffold for the Electron app package.

## Scope in task #1

- Reserve `src/main` for main-process workspace shell wiring
- Reserve `src/renderer` for renderer workspace shell UI wiring
- Keep E2/E4 terminal/editor/LSP behavior out of this package for now

## E2 task 1: node-pty native addon pipeline

- `bun install` (in `packages/app`) runs `postinstall` → `bun run rebuild:native`
- `rebuild:native` runs `@electron/rebuild` against pinned Electron (`35.7.5`) for `node-pty`
- `verify:native` runs rebuild + Electron smoke load (`scripts/smoke/node-pty-electron-main.cjs`)
- `electron-builder.yml` ships `node-pty` native binary via:
  - `asarUnpack: node_modules/node-pty/build/Release/*.node`
  - `extraResources: node_modules/node-pty/build/Release/pty.node -> Contents/Resources/native/node-pty/pty.node`

## E2 task 10: bundled terminal fonts (Korean fallback)

- Bundled OFL font assets live under `assets/fonts/`:
  - `d2coding/D2Coding-Ver1.3.2-20180524.ttf`
  - `d2coding/D2CodingBold-Ver1.3.2-20180524.ttf`
  - `noto-sans-kr/NotoSansKR[wght].ttf`
  - family-specific `OFL.txt` license files
- `electron-builder.yml` ships the entire `assets/fonts/` tree into packaged app resources (`Contents/Resources/fonts`).
- Terminal default stack is set to `"D2Coding", "Noto Sans KR", ui-monospace, ...` via `src/renderer/xterm-fonts.ts` + `XtermView` defaults.

## E2 task 11: Korean IME/rendering release gate

- `bun run test:ime-checklist` executes deterministic checklist coverage for #1, #2, #3, #5, #6, #7 and references #4 via the existing NFC regression test.
- Gate tests + artifacts live under `test/ime-checklist/`.
- Evidence outputs are written to `test/ime-checklist/artifacts/` (`latest-evidence.json`, `latest-summary.md`, screenshot placeholders).
- This gate intentionally does **not** claim full native macOS IME automation.

## E2 task 12: signed-app native manual QA checklist

- Manual release checklist: `test/manual-qa/korean-release-checklist.md`
- Evidence templates/root: `test/manual-qa/release-evidence/`
- Must be executed by human QA on both **arm64 + x64** signed `.app` environments.

## CI / release rule

Before release, **all** conditions below must be true:

1. `bun run test:ime-checklist` passes.
2. Manual signed-app native checklist passes on arm64 and x64 (`test/manual-qa/korean-release-checklist.md`).
3. Evidence bundle is stored under `test/manual-qa/release-evidence/<RUN_ID>/` and final verdict is PASS.

## Remaining manual release checks

Run `bun run verify:native:checklist` to print pending x64 and signed-app checks.

For tasks 10/11/12, signed `.app` visual + native IME verification remains **manual pending** until evidence is captured.
