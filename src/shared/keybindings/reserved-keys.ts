/**
 * Reserved / built-in key catalog — the data half of the keybinding
 * conflict engine.
 *
 * Our dispatcher protects embedded components (Monaco, xterm, the
 * browser tab) by ABSENCE: a key not in the KEYBINDINGS table simply
 * passes through at capture phase. User customization can break that
 * protection at any time (the ⌘/ → split-right bug was exactly this
 * class of failure, introduced by code instead of by a user). This
 * catalog makes the implicit reservation explicit data, so:
 *   - the conflict engine can warn "this will shadow Monaco's comment
 *     toggle" the moment a user records a colliding key;
 *   - the settings UI can render a read-only "keys used by built-ins"
 *     section;
 *   - regressions like ⌘/ are documented in one greppable place.
 *
 * `source` semantics:
 *   - "system"   — OS/window-manager level (⌘Q, ⌘H, ⌘M). The recorder
 *                  refuses these outright.
 *   - "electron" — Cocoa-registered role accelerators (Edit menu
 *                  clipboard roles, zoom, host DevTools). Binding these
 *                  may double-fire or never reach the renderer.
 *   - "monaco"   — Monaco standalone editor defaults (fire when the
 *                  editor has focus). Shadowing breaks editing UX.
 *   - "terminal" — readline / job-control keys the shell owns while
 *                  the terminal has focus (plus app-level terminal
 *                  keys like ⇧↵). Mostly literal Ctrl — relevant on
 *                  Mac too, and doubly so on Win/Linux where
 *                  CmdOrCtrl resolves to Ctrl.
 *
 * NOT exhaustive — entries earn their place by being likely collision
 * targets, not by completeness. Extend freely.
 */

import type { AcceleratorString } from "./index";
import { normalizeKeystroke } from "./keybinding-parse";

export type ReservedKeySource = "system" | "electron" | "monaco" | "terminal";

export interface ReservedKey {
  accelerator: AcceleratorString;
  source: ReservedKeySource;
  /** Translation key for the action reserved by its owner. */
  noteKey: string;
  /** Restrict the reservation to one platform. Absent = both. */
  platform?: "mac" | "non-mac";
}

export const RESERVED_KEYS: readonly ReservedKey[] = [
  // ── system (recorder-blocked) ───────────────────────────────────────
  { accelerator: "Cmd+Q", source: "system", noteKey: "quitApplication", platform: "mac" },
  { accelerator: "Cmd+H", source: "system", noteKey: "hideApplication", platform: "mac" },
  { accelerator: "Cmd+Alt+H", source: "system", noteKey: "hideOthers", platform: "mac" },
  { accelerator: "Cmd+M", source: "system", noteKey: "minimizeWindow", platform: "mac" },

  // ── electron roles (Cocoa-registered accelerators) ──────────────────
  { accelerator: "CmdOrCtrl+C", source: "electron", noteKey: "copy" },
  { accelerator: "CmdOrCtrl+X", source: "electron", noteKey: "cut" },
  { accelerator: "CmdOrCtrl+V", source: "electron", noteKey: "paste" },
  { accelerator: "CmdOrCtrl+A", source: "electron", noteKey: "selectAll" },
  { accelerator: "CmdOrCtrl+Z", source: "electron", noteKey: "undo" },
  { accelerator: "CmdOrCtrl+Shift+Z", source: "electron", noteKey: "redo" },
  { accelerator: "CmdOrCtrl+Alt+I", source: "electron", noteKey: "toggleDevTools" },
  { accelerator: "CmdOrCtrl+0", source: "electron", noteKey: "resetZoom" },
  { accelerator: "CmdOrCtrl+-", source: "electron", noteKey: "zoomOut" },
  { accelerator: "CmdOrCtrl+=", source: "electron", noteKey: "zoomIn" },

  // ── monaco editor defaults (editor focus) ───────────────────────────
  { accelerator: "CmdOrCtrl+/", source: "monaco", noteKey: "toggleLineComment" },
  { accelerator: "CmdOrCtrl+D", source: "monaco", noteKey: "addNextMatch" },
  { accelerator: "CmdOrCtrl+F", source: "monaco", noteKey: "find" },
  { accelerator: "CmdOrCtrl+Alt+F", source: "monaco", noteKey: "replace" },
  { accelerator: "CmdOrCtrl+G", source: "monaco", noteKey: "findNext" },
  { accelerator: "CmdOrCtrl+U", source: "monaco", noteKey: "undoCursor" },
  { accelerator: "CmdOrCtrl+[", source: "monaco", noteKey: "outdent" },
  { accelerator: "CmdOrCtrl+]", source: "monaco", noteKey: "indent" },
  { accelerator: "CmdOrCtrl+Shift+K", source: "monaco", noteKey: "deleteLine" },
  { accelerator: "CmdOrCtrl+Enter", source: "monaco", noteKey: "insertLineBelow" },
  { accelerator: "Alt+Up", source: "monaco", noteKey: "moveLineUp" },
  { accelerator: "Alt+Down", source: "monaco", noteKey: "moveLineDown" },
  { accelerator: "Shift+Alt+Up", source: "monaco", noteKey: "copyLineUp" },
  { accelerator: "Shift+Alt+Down", source: "monaco", noteKey: "copyLineDown" },
  { accelerator: "F1", source: "monaco", noteKey: "editorPalette" },
  { accelerator: "F8", source: "monaco", noteKey: "nextProblem" },
  { accelerator: "F12", source: "monaco", noteKey: "definition" },
  { accelerator: "Shift+F12", source: "monaco", noteKey: "references" },

  // ── terminal / shell (terminal focus) ───────────────────────────────
  { accelerator: "Ctrl+C", source: "terminal", noteKey: "interrupt" },
  { accelerator: "Ctrl+D", source: "terminal", noteKey: "shellEof" },
  { accelerator: "Ctrl+Z", source: "terminal", noteKey: "suspendJob" },
  { accelerator: "Ctrl+R", source: "terminal", noteKey: "reverseSearch" },
  { accelerator: "Ctrl+A", source: "terminal", noteKey: "lineStart" },
  { accelerator: "Ctrl+E", source: "terminal", noteKey: "lineEnd" },
  { accelerator: "Ctrl+W", source: "terminal", noteKey: "deletePreviousWord" },
  { accelerator: "Ctrl+U", source: "terminal", noteKey: "killLineBackward" },
  { accelerator: "Ctrl+K", source: "terminal", noteKey: "killLineForward" },
  { accelerator: "Ctrl+L", source: "terminal", noteKey: "clearScreen" },
  { accelerator: "Ctrl+T", source: "terminal", noteKey: "transpose" },
  { accelerator: "Ctrl+N", source: "terminal", noteKey: "nextHistory" },
  { accelerator: "Ctrl+P", source: "terminal", noteKey: "previousHistory" },
  { accelerator: "Ctrl+O", source: "terminal", noteKey: "operateNext" },
  { accelerator: "Ctrl+S", source: "terminal", noteKey: "flowStop" },
  { accelerator: "Ctrl+Q", source: "terminal", noteKey: "flowResume" },
  { accelerator: "Ctrl+\\", source: "terminal", noteKey: "sigquit" },
  { accelerator: "Shift+Enter", source: "terminal", noteKey: "multiline" },
];

/**
 * Find the reserved entry colliding with `accel` on the given platform,
 * or `undefined`. Comparison uses {@link normalizeKeystroke}, i.e. the
 * same equality `matchesEvent` implies — `CmdOrCtrl+R` collides with
 * `Ctrl+R` on Win/Linux but not on Mac.
 */
export function findReservedKey(accel: AcceleratorString, isMac: boolean): ReservedKey | undefined {
  const norm = normalizeKeystroke(accel, isMac);
  if (norm === null) return undefined;
  return RESERVED_KEYS.find((r) => {
    if (r.platform === "mac" && !isMac) return false;
    if (r.platform === "non-mac" && isMac) return false;
    return normalizeKeystroke(r.accelerator, isMac) === norm;
  });
}
