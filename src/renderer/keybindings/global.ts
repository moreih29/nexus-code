/**
 * Global keyboard shortcut → command-id router.
 *
 * Every keybinding maps to a single command in the catalog (see
 * `shared/commands.ts`). The router only handles dispatch — actual work
 * lives in the registered handler in `use-global-commands.ts`. The
 * Application Menu in the main process targets the same commands via
 * IPC, so the menu and the keyboard always share one implementation.
 *
 * Why a router and not direct handler injection: VSCode-style commands
 * give us one registry per process, decoupled from the listener that
 * wakes the registry up. Future surfaces (command palette, custom
 * keybindings UI) plug into the same registry without touching this
 * file.
 */

import { type CommandId, COMMANDS } from "../../shared/commands";
import { executeCommand } from "../commands/registry";

/**
 * Returns true if the event target is an editable element where global
 * shortcuts should not fire (input, textarea, contenteditable, inside
 * a CodeMirror editor, or inside a Monaco editor — Monaco's textarea
 * sits under `.monaco-editor` and registers its own keybindings).
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

interface KeyMatch {
  /** Command to dispatch when the shortcut fires. */
  command: CommandId;
  /**
   * `true` → fire only when the keystroke originated outside an
   * editable element. Default for app-shell shortcuts so typing in
   * Monaco / inputs isn't hijacked.
   *
   * `false` → always fire (rare — only for shortcuts that are
   * meaningless inside text inputs, e.g. focus moves between groups).
   */
  guardEditable?: boolean;
  match: (e: KeyboardEvent) => boolean;
}

/**
 * `e.code` (physical key) is preferred over `e.key` for shortcuts so
 * Korean / non-Latin keyboard layouts and IME states don't break the
 * dispatch — see prior commits on Cmd+S and Cmd+\ for the rationale.
 */
function isPlainCmd(e: KeyboardEvent): boolean {
  return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
}
function isCmdShift(e: KeyboardEvent): boolean {
  return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey;
}
function isCmdAlt(e: KeyboardEvent): boolean {
  return e.metaKey && !e.shiftKey && e.altKey && !e.ctrlKey;
}
function isCmdShiftAlt(e: KeyboardEvent): boolean {
  return e.metaKey && e.shiftKey && e.altKey && !e.ctrlKey;
}

const BINDINGS: KeyMatch[] = [
  // Cmd+Shift+W — close active group. Listed BEFORE Cmd+W so the more
  // specific modifier set wins.
  {
    command: COMMANDS.groupClose,
    match: (e) => isCmdShift(e) && e.code === "KeyW",
  },
  // Cmd+W — close active tab. Replaces Electron's default "Close Window"
  // accelerator (the Application Menu strips that one).
  {
    command: COMMANDS.tabClose,
    match: (e) => isPlainCmd(e) && e.code === "KeyW",
  },
  // Cmd+R / Cmd+Shift+R — refresh the active workspace's file tree.
  // The Application Menu strips Electron's default Reload / Force Reload.
  {
    command: COMMANDS.filesRefresh,
    match: (e) =>
      (isPlainCmd(e) || isCmdShift(e)) && (e.code === "KeyR" || e.key === "r" || e.key === "R"),
  },
  // Cmd+E / Cmd+O — open file picker.
  {
    command: COMMANDS.fileOpen,
    match: (e) => isPlainCmd(e) && (e.code === "KeyE" || e.code === "KeyO"),
  },
  // Cmd+\ / Cmd+Shift+\ — split active group right / down.
  // (Backslash or Slash physical key for Korean keyboard parity.)
  {
    command: COMMANDS.groupSplitRight,
    match: (e) => isPlainCmd(e) && (e.code === "Backslash" || e.code === "Slash"),
  },
  {
    command: COMMANDS.groupSplitDown,
    match: (e) => isCmdShift(e) && (e.code === "Backslash" || e.code === "Slash"),
  },
  // Cmd/Ctrl+S — save active editor. Code (not key) for IME safety.
  {
    command: COMMANDS.fileSave,
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyS",
  },
  // Cmd+Alt+T — close every other tab in the active group (mac-style).
  {
    command: COMMANDS.tabCloseOthers,
    match: (e) => isCmdAlt(e) && e.code === "KeyT",
  },
  // Cmd+Alt+R — reveal active editor's file in the OS file manager.
  {
    command: COMMANDS.pathReveal,
    match: (e) => isCmdAlt(e) && e.code === "KeyR",
  },
  // Cmd+Alt+C — copy active editor's absolute path.
  {
    command: COMMANDS.pathCopy,
    match: (e) => isCmdAlt(e) && e.code === "KeyC",
  },
  // Cmd+Shift+Alt+C — copy active editor's workspace-relative path.
  {
    command: COMMANDS.pathCopyRelative,
    match: (e) => isCmdShiftAlt(e) && e.code === "KeyC",
  },
  // Cmd+Alt+Arrow — move focus between groups. Arrow keys aren't
  // useful in editables anyway; we still guard so Monaco's own
  // navigation isn't hijacked.
  {
    command: COMMANDS.groupFocusLeft,
    match: (e) => isCmdAlt(e) && e.key === "ArrowLeft",
  },
  {
    command: COMMANDS.groupFocusRight,
    match: (e) => isCmdAlt(e) && e.key === "ArrowRight",
  },
  {
    command: COMMANDS.groupFocusUp,
    match: (e) => isCmdAlt(e) && e.key === "ArrowUp",
  },
  {
    command: COMMANDS.groupFocusDown,
    match: (e) => isCmdAlt(e) && e.key === "ArrowDown",
  },
];

export function handleGlobalKeyDown(e: KeyboardEvent): void {
  for (const binding of BINDINGS) {
    if (!binding.match(e)) continue;
    if (binding.guardEditable !== false && isInEditable(e.target as HTMLElement | null)) {
      // Refresh is intentionally allowed everywhere (matches the prior
      // behaviour that blocks the page-level reload regardless of focus).
      if (binding.command !== COMMANDS.filesRefresh) return;
    }
    e.preventDefault();
    executeCommand(binding.command);
    return;
  }
}
