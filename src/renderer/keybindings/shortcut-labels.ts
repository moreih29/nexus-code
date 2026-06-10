/**
 * Platform-aware shortcut label resolution for context menus.
 *
 * Reads from the resolver's ACTIVE binding table (defaults + user
 * overrides) — not the static `KEYBINDINGS` — so a user-customized
 * shortcut renders correctly everywhere a label is shown. This module's
 * only job is to format an accelerator for the current platform; the
 * underlying binding lives next to the command declaration.
 *
 * Every command surfaced in a context menu has a binding entry —
 * including context-scoped ones like `openToSide` (registered with
 * `when: "fileTreeFocus"`). There is no separate map of hand-written
 * labels.
 *
 * Reactivity note: labels are resolved lazily AT READ TIME (the
 * `SHORTCUTS` members below are getters). Context menus and tooltips
 * mount on open, so they pick up a rebinding on their next render
 * without any subscription plumbing.
 */

import { COMMANDS, type CommandId } from "../../shared/keybindings/commands";
import { acceleratorToLabel, chordToLabel } from "../../shared/keybindings/keybinding-parse";
import { getActiveBindings } from "./resolver";

// `window.host` is provided by the preload bridge in production; in unit
// tests there is no window — fall back to a node-y `process.platform`
// probe (the renderer doesn't ship node types, so we read it through
// `globalThis` to avoid a TS error). Defaults to mac (the dev primary).
function detectIsMac(): boolean {
  if (typeof window !== "undefined" && window.host?.platform) {
    return window.host.platform === "darwin";
  }
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc && typeof proc.platform === "string") {
    return proc.platform === "darwin";
  }
  return true;
}

export const isMac = detectIsMac();

/**
 * Render the shortcut label for a command from the ACTIVE binding
 * table. Returns `undefined` if the command currently has neither a
 * primary nor a chord declaration (including the user-unbound case) —
 * callers can conditionally omit the shortcut column in their menu
 * spec.
 */
export function shortcutFor(command: CommandId): string | undefined {
  const bindings = getActiveBindings();
  const primary = bindings.find((b) => b.command === command && b.primary !== undefined);
  if (primary?.primary !== undefined) {
    return acceleratorToLabel(primary.primary, { isMac });
  }
  const chord = bindings.find((b) => b.command === command && b.chord !== undefined);
  if (chord?.chord !== undefined) {
    return chordToLabel(chord.chord, { isMac });
  }
  return undefined;
}

/**
 * Back-compat shim: the previous `SHORTCUTS` map is still consumed in
 * a handful of places. New callers should prefer `shortcutFor(...)`.
 * Members are GETTERS — resolved against the active binding table at
 * read time, so user rebindings flow through on the next render of
 * whatever surface shows the label.
 */
export const SHORTCUTS = {
  get closeTab() {
    return shortcutFor(COMMANDS.tabClose) ?? "";
  },
  get closeOthers() {
    return shortcutFor(COMMANDS.tabCloseOthers) ?? "";
  },
  get closeSaved() {
    return shortcutFor(COMMANDS.tabCloseSaved) ?? "";
  },
  get closeAll() {
    return shortcutFor(COMMANDS.tabCloseAll) ?? "";
  },
  get pinTab() {
    return shortcutFor(COMMANDS.tabPinToggle) ?? "";
  },
  get splitRight() {
    return shortcutFor(COMMANDS.groupSplitRight) ?? "";
  },
  get splitDown() {
    return shortcutFor(COMMANDS.groupSplitDown) ?? "";
  },
  get revealInOS() {
    return shortcutFor(COMMANDS.pathReveal) ?? "";
  },
  get copyPath() {
    return shortcutFor(COMMANDS.pathCopy) ?? "";
  },
  get copyRelativePath() {
    return shortcutFor(COMMANDS.pathCopyRelative) ?? "";
  },
  get openToSide() {
    return shortcutFor(COMMANDS.openToSide) ?? "";
  },
  get fileRename() {
    return shortcutFor(COMMANDS.fileRename) ?? "";
  },
  get fileCopy() {
    return shortcutFor(COMMANDS.fileCopy) ?? "";
  },
  get fileCut() {
    return shortcutFor(COMMANDS.fileCut) ?? "";
  },
  get filePaste() {
    return shortcutFor(COMMANDS.filePaste) ?? "";
  },
};
