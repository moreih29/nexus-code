/**
 * Single source of truth for application-level keybindings.
 *
 * The renderer's keyboard dispatcher and the Application Menu both
 * derive from this table:
 *   - The dispatcher parses each declaration into an event predicate
 *     and routes the event to `executeCommand`.
 *   - The Application Menu reads the same table to set its
 *     `accelerator` field for single-key bindings, or — for chord
 *     bindings, which Electron cannot register natively — to suffix
 *     the menu label with `[⌘K ⌘W]`.
 *
 * Adding a shortcut is a one-line addition here. There are no parallel
 * tables to keep in sync — this is the architectural fix for what was
 * previously scattered across `keybindings/global.ts`,
 * `main/menu-template.ts`, and `keybindings/shortcut-labels.ts`.
 *
 * Accelerator strings follow Electron's format (`"CmdOrCtrl+W"`,
 * `"CmdOrCtrl+Shift+\\"`). `CmdOrCtrl` resolves to ⌘ on Mac and Ctrl
 * on Win/Linux. The parser also accepts `Cmd`/`Ctrl` explicitly,
 * `Shift`, `Alt`/`Option`. Single-letter tokens map to KeyA…KeyZ.
 */

import { COMMANDS, type CommandId } from "./commands";

/** Same shape Electron's `MenuItemConstructorOptions.accelerator` accepts. */
export type AcceleratorString = string;

export interface KeybindingDecl {
  command: CommandId;
  /**
   * Single-keystroke binding. Becomes the menu item's `accelerator`
   * when there's a corresponding command in the menu.
   */
  primary?: AcceleratorString;
  /**
   * Two-step chord (`[leader, secondary]`). Electron cannot register
   * chords as menu accelerators, so the menu shows them as a
   * `[⌘K ⌘W]` label suffix only — the renderer dispatcher is the
   * sole executor.
   */
  chord?: readonly [AcceleratorString, AcceleratorString];
  /**
   * VSCode-style focus-scoping expression. Evaluated against the
   * keydown's target before the command fires; if the expression is
   * falsy the binding does not match and the dispatcher reports
   * `none`. Absent means "fires regardless of focus" (the VSCode
   * default for application-level shortcuts).
   *
   * Supported keys are listed in `renderer/keybindings/context-keys.ts`.
   * Grammar (`!`, `&&`, `||`, parentheses) is parsed by
   * `shared/keybinding-when.ts`.
   */
  when?: string;
}

/**
 * Application-level keybindings. Order matters only for *display* —
 * the dispatcher prefers single-keystroke matches before considering
 * chord leaders (handled in the dispatcher, not by table order).
 */
export const KEYBINDINGS: readonly KeybindingDecl[] = [
  // File / editor
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+E" },
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+O" },
  { command: COMMANDS.fileSave, primary: "CmdOrCtrl+S" },
  // Refresh blocks the page-level reload regardless of focus.
  { command: COMMANDS.filesRefresh, primary: "CmdOrCtrl+R" },
  { command: COMMANDS.filesRefresh, primary: "CmdOrCtrl+Shift+R" },

  // Open the active file-tree row in a side split. Scoped to the
  // tree so ⌘↵ inside a code editor still inserts a new line.
  { command: COMMANDS.openToSide, primary: "CmdOrCtrl+Enter", when: "fileTreeFocus" },

  // Tabs
  { command: COMMANDS.tabClose, primary: "CmdOrCtrl+W" },
  { command: COMMANDS.tabCloseOthers, primary: "CmdOrCtrl+Alt+T" },
  // Chord-only commands (⌘K …). Cannot be Electron-registered;
  // renderer handles entirely.
  { command: COMMANDS.tabCloseSaved, chord: ["CmdOrCtrl+K", "U"] },
  { command: COMMANDS.tabCloseAll, chord: ["CmdOrCtrl+K", "CmdOrCtrl+W"] },
  // VSCode's binding holds Cmd through the chord (⌘K ⌘⇧↵).
  { command: COMMANDS.tabPinToggle, chord: ["CmdOrCtrl+K", "CmdOrCtrl+Shift+Enter"] },

  // Groups (panels)
  // `\\` here matches both Backslash and Slash physical keys, so
  // Korean keyboards (where Shift+Backslash maps to Slash) hit the
  // same shortcut. Documented in keybinding-parse.ts.
  { command: COMMANDS.groupSplitRight, primary: "CmdOrCtrl+\\" },
  { command: COMMANDS.groupSplitDown, primary: "CmdOrCtrl+Shift+\\" },
  { command: COMMANDS.groupClose, primary: "CmdOrCtrl+Shift+W" },
  { command: COMMANDS.groupFocusLeft, primary: "CmdOrCtrl+Alt+Left" },
  { command: COMMANDS.groupFocusRight, primary: "CmdOrCtrl+Alt+Right" },
  { command: COMMANDS.groupFocusUp, primary: "CmdOrCtrl+Alt+Up" },
  { command: COMMANDS.groupFocusDown, primary: "CmdOrCtrl+Alt+Down" },

  // Path actions on the active editor
  { command: COMMANDS.pathReveal, primary: "CmdOrCtrl+Alt+R" },
  { command: COMMANDS.pathCopy, primary: "CmdOrCtrl+Alt+C" },
  { command: COMMANDS.pathCopyRelative, primary: "CmdOrCtrl+Shift+Alt+C" },
];

/**
 * Find the first declaration for `command`. Multiple declarations are
 * allowed (e.g. ⌘E and ⌘O both bind file.open) — `find*` returns the
 * primary representative for label / menu purposes.
 */
export function findPrimaryBinding(command: CommandId): KeybindingDecl | undefined {
  return KEYBINDINGS.find((k) => k.command === command && k.primary !== undefined);
}

export function findChordBinding(command: CommandId): KeybindingDecl | undefined {
  return KEYBINDINGS.find((k) => k.command === command && k.chord !== undefined);
}

/** All declarations for a command (an array is rare but valid). */
export function findAllBindings(command: CommandId): KeybindingDecl[] {
  return KEYBINDINGS.filter((k) => k.command === command);
}
