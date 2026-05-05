/**
 * Platform-aware shortcut label resolution for context menus.
 *
 * Reads from `shared/keybindings.ts`, which is the single source of
 * truth. This module's only job is to format an accelerator for the
 * current platform — the underlying binding lives next to the command
 * declaration.
 *
 * Every command surfaced in a context menu now has a `KEYBINDINGS`
 * entry, including `openToSide` (registered with `when: "fileTreeFocus"`
 * since Phase 3). There is no longer a separate map of hand-written
 * labels.
 */

import { COMMANDS, type CommandId } from "../../shared/commands";
import { acceleratorToLabel, chordToLabel } from "../../shared/keybinding-parse";
import { findChordBinding, findPrimaryBinding } from "../../shared/keybindings";

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
 * Render the shortcut label for a command. Returns `undefined` if the
 * command has neither a primary nor a chord declaration — callers can
 * conditionally omit the shortcut column in their menu spec.
 */
export function shortcutFor(command: CommandId): string | undefined {
  const primary = findPrimaryBinding(command);
  if (primary?.primary !== undefined) {
    return acceleratorToLabel(primary.primary, { isMac });
  }
  const chord = findChordBinding(command);
  if (chord?.chord !== undefined) {
    return chordToLabel(chord.chord, { isMac });
  }
  return undefined;
}

/**
 * Back-compat shim: the previous `SHORTCUTS` map is still consumed in
 * a handful of places. New callers should prefer `shortcutFor(...)`.
 * Each value is computed once at module load by looking up the
 * registry, so changing a binding flows through automatically.
 */
export const SHORTCUTS = {
  closeTab: shortcutFor(COMMANDS.tabClose) ?? "",
  closeOthers: shortcutFor(COMMANDS.tabCloseOthers) ?? "",
  closeSaved: shortcutFor(COMMANDS.tabCloseSaved) ?? "",
  closeAll: shortcutFor(COMMANDS.tabCloseAll) ?? "",
  pinTab: shortcutFor(COMMANDS.tabPinToggle) ?? "",
  splitRight: shortcutFor(COMMANDS.groupSplitRight) ?? "",
  splitDown: shortcutFor(COMMANDS.groupSplitDown) ?? "",
  revealInOS: shortcutFor(COMMANDS.pathReveal) ?? "",
  copyPath: shortcutFor(COMMANDS.pathCopy) ?? "",
  copyRelativePath: shortcutFor(COMMANDS.pathCopyRelative) ?? "",
  openToSide: shortcutFor(COMMANDS.openToSide) ?? "",
} as const;
