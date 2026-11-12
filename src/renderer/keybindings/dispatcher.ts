/**
 * Keyboard shortcut dispatcher.
 *
 * Composes three pure modules:
 *   - {@link ./resolver} maps each keydown to a {@link Resolution} and
 *     evaluates the binding's `when` expression against the keydown
 *     event's target.
 *   - {@link ./chord-state} owns the pending-chord state machine.
 *   - {@link ../../shared/keybindings} owns the binding catalog.
 *
 * The dispatcher itself is the only side-effecting layer:
 *   - calls `executeCommand` from the registry,
 *   - calls `e.preventDefault()` and signals "claim" back to the
 *     listener via its boolean return so the listener can
 *     `stopImmediatePropagation()`.
 *
 * Listener wiring lives in `use-global-keybindings.ts`. The listener
 * runs in the capture phase so Monaco's standalone keybinding service,
 * which sits on the editor's container in bubble phase, doesn't
 * swallow our shortcuts (notably the chord leader ⌘K) before we can
 * see them.
 */

import { executeCommand } from "../commands/registry";
import {
  __setClockForTests,
  chordClock,
  clearPending,
  enterPending,
  getPendingLeader,
  isModifierKeyOnly,
  purgeExpired,
  __resetForTests as resetChordState,
} from "./chord-state";
import { evaluateContextKey } from "./context-keys";
import { resolveEvent } from "./resolver";

// ---------------------------------------------------------------------------
// Test hooks (re-exported for tests that previously imported from this
// file directly).
// ---------------------------------------------------------------------------

export { __setClockForTests as __setChordClockForTests };

// ---------------------------------------------------------------------------
// Chords in the editor (Win/Linux)
// ---------------------------------------------------------------------------

/**
 * When a chord leader last went to Monaco, whose next keystroke is Monaco's
 * too; null when none is pending. Monaco gives up on a chord after
 * {@link EDITOR_CHORD_TIMEOUT_MS}, and the keystroke is the app's again.
 */
let editorChordSince: number | null = null;

/** How long Monaco waits for a chord's second key. */
const EDITOR_CHORD_TIMEOUT_MS = 5000;

/**
 * Whether Monaco resolves a chord started at `e`: on Win/Linux, while the
 * editor has focus. macOS keeps the app's own chord handling.
 */
function editorTakesChords(e: KeyboardEvent): boolean {
  return !evaluateContextKey("isMac", e) && evaluateContextKey("editorFocus", e);
}

/** Test-only: clears the pending chord, the app's or Monaco's. */
export function __resetChordStateForTests(): void {
  resetChordState();
  editorChordSince = null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Process one keydown.
 *
 * Returns `true` when we claimed the event (the listener should
 * `stopImmediatePropagation()` and skip Monaco / xterm handlers).
 * Returns `false` to let the event continue to other listeners and
 * any registered Cocoa menu accelerator.
 */
export function handleGlobalKeyDown(e: KeyboardEvent): boolean {
  // ── 0a. IME composition guard.
  //   While a Korean/Japanese IME is composing (composition) in the helper textarea,
  //   modifier+letter shortcuts (`Cmd+C`, `Cmd+V`, …) are also matched by `e.code`, so
  //   `matchesEvent` hits as is. If `preventDefault` +
  //   `stopImmediatePropagation` are called after a match, the textarea's IME state
  //   desyncs and Hangul input gets duplicated or the same character gets stuck.
  //   During composition no shortcut is dispatched; events are passed straight through to
  //   xterm.js / Monaco / other text inputs.
  //
  //   `e.keyCode === 229` is a fallback that catches the case where, in older Chromium, the `isComposing` flag is
  //   set late on some keydowns — xterm.js internally
  //   uses the same dual-guard pattern.
  if (e.isComposing || e.keyCode === 229) return false;

  // ── 0b. Lazy expiry sweep so a stale chord can't mis-route.
  purgeExpired();

  // ── 1. Modifier-only keystrokes never carry a binding and must not
  //       disturb the pending state (releasing / re-pressing ⌘ between
  //       leader and second key is normal user behaviour).
  if (isModifierKeyOnly(e)) return false;

  // ── 1b. A chord leader pressed in the editor went to Monaco (see
  //        `case "chord-leader"`): this keystroke completes Monaco's
  //        chord, so let it through untouched.
  if (editorChordSince !== null) {
    const live = chordClock() - editorChordSince < EDITOR_CHORD_TIMEOUT_MS;
    editorChordSince = null;
    if (live && evaluateContextKey("editorFocus", e)) return false;
  }

  if (evaluateContextKey("commandPaletteFocus", e)) return false;

  // The keybinding recorder (Settings → Keyboard Shortcuts) captures raw
  // keystrokes to record a new binding — never dispatch while it owns
  // the keydown target, or recording ⌘W would close the tab instead.
  if (evaluateContextKey("keybindingRecorderFocus", e)) return false;

  // ── 2. Escape during pending cancels silently. Outside pending,
  //       Escape isn't ours; let it through.
  const pendingLeader = getPendingLeader();
  if (
    pendingLeader !== null &&
    e.key === "Escape" &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey
  ) {
    clearPending();
    e.preventDefault();
    return true;
  }

  // ── 3. Resolve and dispatch.
  const result = resolveEvent(e, pendingLeader);

  switch (result.kind) {
    case "chord-completed":
      e.preventDefault();
      executeCommand(result.command);
      clearPending();
      return true;

    case "chord-mismatch":
      // VSCode swallows the second keystroke and clears the chord.
      clearPending();
      e.preventDefault();
      return true;

    case "chord-leader":
      // Win/Linux: in the editor the leader goes to Monaco, whose own
      // chords share it (Ctrl+K Ctrl+C add comment, Ctrl+K Ctrl+0 fold
      // all, …). The app's chords are bound in Monaco too
      // (services/editor/keybindings/app-chords.ts), so Monaco resolves
      // both, and the next keystroke is Monaco's (step 1b).
      if (editorTakesChords(e)) {
        editorChordSince = chordClock();
        return false;
      }
      // Elsewhere, and on macOS everywhere, the chord pipeline is ours:
      // ⌘K is never accidentally typed, so it means "begin a chord".
      e.preventDefault();
      enterPending(result.leaderId);
      return true;

    case "single":
      // Focus-scoping (e.g. `when: "fileTreeFocus"`) is resolved inside
      // `resolveEvent`. A `single` here is already gated by `when`.
      e.preventDefault();
      executeCommand(result.command);
      return true;

    case "none":
      return false;
  }
}
