/**
 * Keyboard shortcut dispatcher.
 *
 * Composes three pure modules:
 *   - {@link ./resolver} maps each keydown to a {@link Resolution} —
 *     also evaluates the binding's `when` expression (Phase 3) against
 *     the keydown event's target.
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
  __resetForTests as __resetChordStateForTests,
  __setClockForTests,
  clearPending,
  enterPending,
  getPendingLeader,
  isModifierKeyOnly,
  purgeExpired,
} from "./chord-state";
import { resolveEvent } from "./resolver";

// ---------------------------------------------------------------------------
// Editable detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the event target is an editable element where global
 * shortcuts should not fire (input, textarea, contenteditable, inside
 * a CodeMirror editor, or inside a Monaco editor).
 *
 * Exported for unit testing.
 */
export function isInEditable(target: HTMLElement | null): boolean {
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true ||
    target?.closest(".cm-editor") != null ||
    target?.closest(".monaco-editor") != null
  );
}

// ---------------------------------------------------------------------------
// Test hooks (re-exported for tests that previously imported from this
// file directly).
// ---------------------------------------------------------------------------

export {
  __resetChordStateForTests,
  __setClockForTests as __setChordClockForTests,
};

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
  // ── 0. Lazy expiry sweep so a stale chord can't mis-route.
  purgeExpired();

  // ── 1. Modifier-only keystrokes never carry a binding and must not
  //       disturb the pending state (releasing / re-pressing ⌘ between
  //       leader and second key is normal user behaviour).
  if (isModifierKeyOnly(e)) return false;

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
      // The chord pipeline is intentional — ⌘K is never accidentally
      // typed — so we don't gate it on focus context here. Even when
      // the user is in Monaco, ⌘K means "begin a chord".
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
