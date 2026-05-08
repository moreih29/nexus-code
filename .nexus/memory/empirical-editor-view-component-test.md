# empirical: editor-view component test intentionally absent

## Decision

`src/renderer/components/workspace/content/editor-view.tsx` does not have a component-level rendering test, and this is an intentional choice.

## Background

During the Plan #22/#23 audit, tester surfaced this as IMPORTANT-6 ("editor-view 컴포넌트 마운트 테스트 없음") and recommended an explicit decision rather than silent absence. After Plan #23 task T6, EditorView shrank from 281 → 84 LoC, narrowing what a component test would actually verify.

## Reasoning

1. **Cost of mocking monaco-editor in jsdom**: monaco-editor's `IStandaloneCodeEditor` relies on `ResizeObserver`, `IntersectionObserver`, layout measurement, and DOM APIs that jsdom either lacks or implements incompletely. Faking these to the point where a component test exercises real render paths costs more than the test buys, and a poorly-faked editor produces silent passes (the dangerous failure mode).

2. **Residual responsibility is thin**: After T6 decomposition, EditorView's body is:
   - phase branches (`phase === "loading" | "error" | "ready"`) — trivial conditional render
   - composition of extracted units that each have their own unit tests:
     - `useEditorMount` hook (refs, effects, attachSharedModel)
     - `applySharedModel` (covered by `editor-readonly-options.test.ts` after T12 strengthening)
     - `createCrossFileOpenCodeEditorOpener` (pure, testable in isolation)
     - `revealRange` / `applyPendingReveal` (pure)
     - `installEditorSaveAction` (covered by save-service tests)
   - `<Centered>` presentational helper — trivial

3. **Regression coverage moves elsewhere**: The behaviors a component test would catch (mount/unmount lifecycle, model attach order, opener install timing) are better caught by:
   - integration tests that drive the actual Electron app, OR
   - manual verification on the dev build

## Alternatives considered

- **jsdom-based component test with mocked monaco**: rejected. High maintenance cost; fake editor diverges from real `IStandaloneCodeEditor`; provides false confidence.
- **Snapshot testing without monaco**: rejected. EditorView's JSX is mostly delegation; snapshots would catch only trivial render churn.

## Future work

If the gap proves painful:
- **Storybook + visual regression** for the phase branches (loading / error / ready shells without real monaco).
- **Playwright e2e** that opens a workspace and asserts editor mounts — covers the integration concerns this unit test gap leaves open.

## Trigger to revisit

Reopen this decision if any of:
- `EditorView` grows past ~150 LoC again (new responsibilities crept back).
- A regression escapes that a component-level test would have caught.
- monaco-editor publishes a documented jsdom story (currently it does not).
