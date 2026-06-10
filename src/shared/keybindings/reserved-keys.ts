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
  /** Short English description of what the key does in its owner. */
  note: string;
  /** Restrict the reservation to one platform. Absent = both. */
  platform?: "mac" | "non-mac";
}

export const RESERVED_KEYS: readonly ReservedKey[] = [
  // ── system (recorder-blocked) ───────────────────────────────────────
  { accelerator: "Cmd+Q", source: "system", note: "Quit application", platform: "mac" },
  { accelerator: "Cmd+H", source: "system", note: "Hide application", platform: "mac" },
  { accelerator: "Cmd+Alt+H", source: "system", note: "Hide other applications", platform: "mac" },
  { accelerator: "Cmd+M", source: "system", note: "Minimize window", platform: "mac" },

  // ── electron roles (Cocoa-registered accelerators) ──────────────────
  { accelerator: "CmdOrCtrl+C", source: "electron", note: "Copy" },
  { accelerator: "CmdOrCtrl+X", source: "electron", note: "Cut" },
  { accelerator: "CmdOrCtrl+V", source: "electron", note: "Paste" },
  { accelerator: "CmdOrCtrl+A", source: "electron", note: "Select all" },
  { accelerator: "CmdOrCtrl+Z", source: "electron", note: "Undo" },
  { accelerator: "CmdOrCtrl+Shift+Z", source: "electron", note: "Redo" },
  { accelerator: "CmdOrCtrl+Alt+I", source: "electron", note: "Toggle window DevTools" },
  { accelerator: "CmdOrCtrl+0", source: "electron", note: "Reset zoom" },
  { accelerator: "CmdOrCtrl+-", source: "electron", note: "Zoom out" },
  { accelerator: "CmdOrCtrl+=", source: "electron", note: "Zoom in" },

  // ── monaco editor defaults (editor focus) ───────────────────────────
  { accelerator: "CmdOrCtrl+/", source: "monaco", note: "Toggle line comment" },
  { accelerator: "CmdOrCtrl+D", source: "monaco", note: "Add selection to next find match" },
  { accelerator: "CmdOrCtrl+F", source: "monaco", note: "Find" },
  { accelerator: "CmdOrCtrl+Alt+F", source: "monaco", note: "Replace" },
  { accelerator: "CmdOrCtrl+G", source: "monaco", note: "Find next" },
  { accelerator: "CmdOrCtrl+U", source: "monaco", note: "Undo cursor position" },
  { accelerator: "CmdOrCtrl+[", source: "monaco", note: "Outdent line" },
  { accelerator: "CmdOrCtrl+]", source: "monaco", note: "Indent line" },
  { accelerator: "CmdOrCtrl+Shift+K", source: "monaco", note: "Delete line" },
  { accelerator: "CmdOrCtrl+Enter", source: "monaco", note: "Insert line below" },
  { accelerator: "Alt+Up", source: "monaco", note: "Move line up" },
  { accelerator: "Alt+Down", source: "monaco", note: "Move line down" },
  { accelerator: "Shift+Alt+Up", source: "monaco", note: "Copy line up" },
  { accelerator: "Shift+Alt+Down", source: "monaco", note: "Copy line down" },
  { accelerator: "F1", source: "monaco", note: "Editor command palette" },
  { accelerator: "F8", source: "monaco", note: "Go to next problem" },
  { accelerator: "F12", source: "monaco", note: "Go to definition" },
  { accelerator: "Shift+F12", source: "monaco", note: "Go to references" },

  // ── terminal / shell (terminal focus) ───────────────────────────────
  { accelerator: "Ctrl+C", source: "terminal", note: "SIGINT (interrupt)" },
  { accelerator: "Ctrl+D", source: "terminal", note: "EOF / exit shell" },
  { accelerator: "Ctrl+Z", source: "terminal", note: "Suspend job (SIGTSTP)" },
  { accelerator: "Ctrl+R", source: "terminal", note: "Reverse history search" },
  { accelerator: "Ctrl+A", source: "terminal", note: "Beginning of line" },
  { accelerator: "Ctrl+E", source: "terminal", note: "End of line" },
  { accelerator: "Ctrl+W", source: "terminal", note: "Delete previous word" },
  { accelerator: "Ctrl+U", source: "terminal", note: "Kill line backward" },
  { accelerator: "Ctrl+K", source: "terminal", note: "Kill line forward" },
  { accelerator: "Ctrl+L", source: "terminal", note: "Clear screen" },
  { accelerator: "Ctrl+T", source: "terminal", note: "Transpose characters" },
  { accelerator: "Ctrl+N", source: "terminal", note: "Next history entry" },
  { accelerator: "Ctrl+P", source: "terminal", note: "Previous history entry" },
  { accelerator: "Ctrl+O", source: "terminal", note: "Operate and get next" },
  { accelerator: "Ctrl+S", source: "terminal", note: "Flow control stop (XOFF)" },
  { accelerator: "Ctrl+Q", source: "terminal", note: "Flow control resume (XON)" },
  { accelerator: "Ctrl+\\", source: "terminal", note: "SIGQUIT" },
  { accelerator: "Shift+Enter", source: "terminal", note: "Multi-line input (app)" },
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
