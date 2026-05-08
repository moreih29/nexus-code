# Monaco Canceled rejection — DevTools-only noise

## Symptom

After Cmd+Shift+O (Go to Symbol) → ESC, the renderer DevTools console prints:

```
editor.api-XXX.js:7 Uncaught (in promise) Canceled: Canceled
```

No terminal log, no app misbehavior. Functionality is intact — providers
return empty results on cancel and the picker closes normally.

## Why our rejection-sink does not catch it

`src/renderer/services/editor/rejection-sink.ts` listens on
`window.addEventListener("unhandledrejection", ...)` and calls
`event.preventDefault()` for `name/message === "Canceled"`. When the symptom
above occurs, the listener verifiably DOES NOT fire (confirmed via diagnostic
warns on `unhandledrejection`, `rejectionhandled`, and `error` events — all
zero hits while the console error still appeared).

Mechanism: V8's inspector reports "rejection might be uncaught" to Chromium
DevTools BEFORE the spec-defined `unhandledrejection` event would fire. If a
handler is later attached in the same task (which monaco internally does via
its QuickAccess controller chain), V8 considers the rejection handled per
spec and never dispatches `unhandledrejection`. But the inspector log has
already been emitted, with no JS-level hook to suppress it.

`event.preventDefault()` only suppresses the spec-path log. The inspector
path is independent.

## What to do (and not to do)

- DO NOT spend further cycles trying to suppress this from JS. The path
  doesn't exist. Future attempts (Promise.prototype patches, monaco internal
  hooks, etc.) are over-engineering for a cosmetic dev-only noise.
- DO leave `installRejectionSink()` in place — it still catches the
  spec-compliant subset of Canceled rejections, which can occur from other
  monaco code paths (e.g. abandoned hover requests).
- If the noise is locally annoying, use the DevTools Console filter box:
  enter `-Canceled: Canceled` to hide messages containing that substring.
- Production users do not see DevTools, so end users are unaffected.

## Diagnostic record

Verified in `fix/editor-lsp-stability` follow-up after commit `848d506`:
1. Boot log `[rejection-sink] installed` confirmed sink module loads.
2. `unhandledrejection`, `rejectionhandled`, and `error` listeners
   instrumented with diagnostic warns — all silent on Cmd+Shift+O→ESC.
3. Source location `editor.api-CalNCsUg.js:7` corresponds to monaco's
   editor.api chunk; no public hook into monaco's internal cancellation
   plumbing exists for standalone monaco-editor.
