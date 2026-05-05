/**
 * Keyboard shortcut dispatcher.
 *
 * Composes three pure modules:
 *   - {@link ./resolver} maps each keydown to a {@link Resolution}.
 *   - {@link ./chord-state} owns the pending-chord state machine.
 *   - {@link ../../shared/keybindings} owns the binding catalog.
 *
 * The dispatcher itself is the only side-effecting layer:
 *   - reads `e.target` for the editable guard,
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

import { acceleratorToLabel, chordToLabel } from "../../shared/keybinding-parse";
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
// Debug logging — TEMPORARY, removed once the chord pipeline is stable
// in dev. Lines are greppable in DevTools console as `[chord]`.
// ---------------------------------------------------------------------------

function debugLog(...args: unknown[]): void {
  console.log("[chord]", ...args);
}

function describeEvent(e: KeyboardEvent): string {
  const mods = [
    e.metaKey ? "meta" : null,
    e.ctrlKey ? "ctrl" : null,
    e.altKey ? "alt" : null,
    e.shiftKey ? "shift" : null,
  ]
    .filter(Boolean)
    .join("+");
  return `key=${JSON.stringify(e.key)} code=${e.code}${mods ? ` mods=${mods}` : ""}`;
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
  debugLog("keydown", describeEvent(e), { hasPending: getPendingLeader() !== null });

  // ── 0. Lazy expiry sweep so a stale chord can't mis-route.
  if (purgeExpired()) {
    debugLog("pending expired, cleared");
  }

  // ── 1. Modifier-only keystrokes never carry a binding and must not
  //       disturb the pending state (releasing / re-pressing ⌘ between
  //       leader and second key is normal user behaviour).
  if (isModifierKeyOnly(e)) {
    debugLog("modifier-only — ignored");
    return false;
  }

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
    debugLog("Escape during pending → cancel");
    clearPending();
    e.preventDefault();
    return true;
  }

  // ── 3. Resolve and dispatch.
  const result = resolveEvent(e, pendingLeader);

  switch (result.kind) {
    case "chord-completed": {
      debugLog("chord completed → dispatch", { command: result.command });
      e.preventDefault();
      executeCommand(result.command);
      clearPending();
      return true;
    }

    case "chord-mismatch": {
      // VSCode swallows the second keystroke and clears the chord.
      debugLog("chord mismatch — swallow + clear", describeEvent(e));
      clearPending();
      e.preventDefault();
      return true;
    }

    case "chord-leader": {
      // Phase 2: the chord pipeline is intentional — ⌘K is never
      // accidentally typed — so we don't honor an editable guard
      // here. Even when the user is in Monaco, ⌘K means "begin a
      // chord".
      debugLog("leader → pending", { leader: result.leaderId });
      e.preventDefault();
      enterPending(result.leaderId);
      return true;
    }

    case "single": {
      if (result.respectGuardEditable && isInEditable(e.target as HTMLElement | null)) {
        // Bail without claiming. The Cocoa menu accelerator (if any)
        // will still fire the same command via the menu IPC, so the
        // user-visible behaviour is preserved for typical shortcuts
        // like ⌘W in the editor.
        return false;
      }
      debugLog("single match → dispatch", { command: result.command });
      e.preventDefault();
      executeCommand(result.command);
      return true;
    }

    case "none":
      debugLog("no binding matched");
      return false;
  }
}

// Re-exports kept available for context-menu label utilities living
// alongside the dispatcher.
export { acceleratorToLabel, chordToLabel };
