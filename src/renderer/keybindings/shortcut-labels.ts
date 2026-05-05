/**
 * Platform-aware shortcut label strings used by context-menu items.
 *
 * Mac uses the symbol forms (⌘ ⌥ ⇧ ⌃), Win/Linux fall back to spelled
 * modifiers (Ctrl, Alt, Shift). KeyChord sequences (e.g. `⌘K U`) are
 * represented as their final printed form — they only render in the
 * menu, the actual key handlers are 1-step today.
 */

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

const MOD = isMac ? "⌘" : "Ctrl";
const ALT = isMac ? "⌥" : "Alt";
const SHIFT = isMac ? "⇧" : "Shift";

function combo(...parts: string[]): string {
  return isMac ? parts.join("") : parts.join("+");
}

export const SHORTCUTS = {
  // Tab / editor group actions
  closeTab: combo(MOD, "W"),
  closeOthers: isMac ? combo(MOD, ALT, "T") : "",
  closeSaved: isMac ? `${MOD}K U` : "Ctrl+K U",
  closeAll: isMac ? `${MOD}K ${MOD}W` : "Ctrl+K Ctrl+W",
  pinTab: isMac ? `${MOD}K ${SHIFT}↵` : "Ctrl+K Shift+Enter",
  splitRight: combo(MOD, "\\"),
  splitDown: combo(MOD, SHIFT, "\\"),

  // File-tree actions
  openToSide: combo(MOD, "↵"),
  revealInOS: isMac ? combo(MOD, ALT, "R") : combo(SHIFT, ALT, "R"),
  copyPath: isMac ? combo(MOD, ALT, "C") : combo(SHIFT, ALT, "C"),
  copyRelativePath: isMac ? combo(MOD, SHIFT, ALT, "C") : "",
} as const;
