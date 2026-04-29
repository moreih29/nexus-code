# Empirical — Plan 34 workbench skeleton retrospective

## Scope

Plan #34 attempted a single-cycle workbench skeleton integration after Plan #33 left several design and production wire-in gaps. The cycle covered flexlayout production wire-in, AppShell decomposition, service-boundary work, active-pane visual assertions, system smoke coverage, and CI workflow setup.

This retrospective records verified cycle results and follow-up debt. It is not a claim that the workbench is finished.

## What worked

- The exact 10-fixture system smoke command passed after correction in T18: `11 pass, 0 fail, 286 expect() calls`, elapsed ~27.81s/28s.
- T13 StrictMode fixture passed across 5 mount/unmount cycles with 0 `getSnapshot` warnings, 0 maximum update depth errors, and 0 DOM leak.
- T5 dock-layout runtime passed against the production flexlayout provider, including 4-pane open/split/move behavior.
- T14 fixed the spatial commands and active/inactive contrast that T9 had exposed. The final six-group fixture passed with luminance delta ~0.0799 against the 0.05 threshold.
- The CI workflow file `.github/workflows/system-smoke.yml` was added. A local equivalent passed; a real GitHub PR/fail-injection run was not performed in this cycle.

## What was difficult

- T17/T18 initially exposed an `app-file-tree-refresh-runtime` failure. The root cause was that the fixture imported `App` directly and bypassed `renderer/main.ts`, so `flexlayout-theme.css` was missing and the content area had zero height. The fix was to import `flexlayout-theme.css` in `app-file-tree-refresh-runtime.entry.tsx`.
- T9 initially failed because the T14 Cmd+Alt+↑/↓ bindings were missing and the active/inactive contrast delta was below the fixture threshold. T14 fixed both the spatial commands and the contrast.
- AppShell decomposition met the hard line-count limit but did not reach the target range. After T15, `AppShell.tsx` was 387 lines. The hard limit of ≤400 passed; the 250–300 target was not reached by design choice to avoid risky further extraction.
- CI coverage was added as configuration, but the cycle did not exercise the real GitHub PR/fail-injection path. Only the local equivalent is verified.

## Plan #33 I4 correction

The Plan #34 correction came from reading the Plan #33 decision text, not the issue title.

- Plan #33 history issue 3 title was: “활성 패널 ring 인디케이터 처리 (현재 Terminal Teal inset ring 의도된 spec)”.
- The decision text adopted C안: inset Terminal Teal ring was discarded, active state moved to header background difference only, and native `:focus-visible` remained for focus.
- The lesson is that an issue title is not source-of-truth; the decision text is.

This matters because the earlier I4 evaluation treated the title as if the Terminal Teal inset ring remained the intended spec. The recorded decision says the opposite.

## Big-bang result data

- The T18 exact 10-fixture system smoke command passed after correction: `11 pass, 0 fail, 286 expect() calls`, elapsed ~27.81s/28s.
- T13 StrictMode runtime result: 5 mount/unmount cycles, 0 `getSnapshot` warnings, 0 maximum update depth, 0 DOM leak.
- T9/T14 six-group spatial runtime result: initial failure due missing Cmd+Alt+↑/↓ bindings and insufficient active/inactive contrast; final fixture passed with luminance delta ~0.0799 against threshold 0.05.
- AppShell line-count result after T15: 387 lines. Hard limit ≤400 passed; 250–300 target not reached by design choice to avoid risky further extraction.
- CI result: `.github/workflows/system-smoke.yml` was added. A local equivalent passed. Real GitHub PR/fail-injection was not run.

## flexlayout production wire-in result

- T5 dock-layout runtime passed against the production flexlayout provider.
- The verified runtime behavior included 4-pane open/split/move.
- T17/T18 showed that fixture entrypoints can bypass production CSS imports when they import `App` directly instead of entering through `renderer/main.ts`. The specific missing import was `flexlayout-theme.css`; the correction was added to `app-file-tree-refresh-runtime.entry.tsx`.

## AppShell decomposition result

- AppShell was decomposed far enough to reach 387 lines after T15.
- The hard limit of ≤400 lines passed.
- The 250–300 target was not reached. The recorded reason was a design choice to avoid risky further extraction late in the cycle.
- The result is therefore a bounded pass against the hard limit, not full completion of the original target range.

## Plan #35 follow-up debt

- Move terminal DOM helpers, including `focusTerminal`, `clickNewTerminalTab`, and related helpers, into `ITerminalService`.
- Move xterm instance ownership into `ITerminalService`.
- Change BottomPanel terminal view so it consumes `ITerminalService` directly.
- Revisit active-pane contrast or ring only if dogfooding, user feedback, or accessibility evaluation shows that `bg-card` versus inactive contrast is insufficient. T14 raised contrast enough for the fixture, but full accessibility remains a follow-up trigger rather than a completed result.
