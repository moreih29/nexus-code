# Manual Native GUI Validation — User Report

- Run ID: `2026-04-24T15-12-00KST_task11`
- Manual validation timestamp: `2026-04-24 15:30 KST`
- Validator: project owner / human operator
- App launch mode: `cd packages/app && bun run dev` unsigned dev launch
- Branch: `feat/phase-a-runnable-shell`

## User-reported results

| Criterion | Result | Evidence basis |
| --- | --- | --- |
| Workspace-specific terminal cwd | PASS | User confirmed terminal opens under each selected workspace path after cwd fix. |
| Terminal visibility/input | PASS | User confirmed terminal renders and input works. |
| Multi-workspace sidecar startup | PASS | User provided sidecar startup logs for three restored workspaces. |
| Basic input/output | PASS | User reported all non-switching checks passed. |
| Multi-tab behavior | PASS | User reported all non-switching checks passed. |
| Korean IME manual behavior | PASS | User reported all checks other than the switching rendering issue passed. |
| Restart/session restore | PASS | User reported all checks other than the switching rendering issue passed. |
| Sidecar cleanup/isolation | PASS | Automated process lifecycle evidence already passed; user reported remaining manual items passed. |
| Fast workspace switching visual stability | PASS after fix | User initially reproduced a blurry/broken xterm render while rapidly switching workspaces. Fix applied: xterm texture atlas clear + full refresh on visibility repair, plus next-animation-frame repair. User then reported: “해당 문제 더 이상 재현안됨. 해결된듯함.” |

## Defects found during manual validation and fixes

1. **xterm Unicode addon proposed API error**
   - Symptom: `You must set the allowProposedApi option to true to use proposed API`.
   - Fix: force `allowProposedApi: true` in `XtermView` terminal options.

2. **Electron dev renderer file fallback failure**
   - Symptom: `ERR_FILE_NOT_FOUND` for `out/renderer/index.html` during dev startup.
   - Fix: prefer `process.env.ELECTRON_RENDERER_URL`; make `start` build before preview.

3. **Terminal focus/input and xterm CSS issue**
   - Symptom: terminal visible but text input did not work.
   - Fix: import `@xterm/xterm/css/xterm.css`; focus visible terminal view on activation/click.

4. **Terminal cwd mismatch**
   - Symptom: new terminals started in `packages/app` instead of workspace absolute path.
   - Fix: main terminal router resolves `workspaceId -> WorkspacePersistenceStore.absolutePath` and injects `cwd` into open command.

5. **Fast workspace switching WebGL render corruption**
   - Symptom: rapid switching caused visibly degraded/broken terminal glyph rendering; user supplied screenshots in the chat before the fix.
   - Fix: `XtermView.fit()` now clears the WebGL texture atlas and refreshes all rows; `ShellTerminalTabs` also schedules a next-animation-frame repair when a tab becomes visible.
   - Retest: user reported the issue no longer reproduces.

## Verdict

**PASS (manual-native criteria closed by human validation).**

The original harness-only result was PARTIAL because native UI/IME validation could not be executed by the agent harness. The project owner has now completed the manual run, reported all criteria passing, and confirmed the only discovered switching-rendering defect no longer reproduces after the repair patch.
