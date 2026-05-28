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
 * previously scattered across `keybindings/global.ts` and
 * `main/menu-template.ts`.
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
  // ⌘N opens a new untitled file (VSCode parity). The previous
  // ⌘N → Add Workspace binding has moved to ⌘⇧N (see below).
  { command: COMMANDS.fileNew, primary: "CmdOrCtrl+N" },
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+E" },
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+O" },
  { command: COMMANDS.fileSave, primary: "CmdOrCtrl+S" },
  // Refresh blocks the page-level reload regardless of focus.
  { command: COMMANDS.filesRefresh, primary: "CmdOrCtrl+R" },
  { command: COMMANDS.filesRefresh, primary: "CmdOrCtrl+Shift+R" },

  // Open the active file-tree row in a side split. Scoped to the
  // tree so ⌘↵ inside a code editor still inserts a new line.
  { command: COMMANDS.openToSide, primary: "CmdOrCtrl+Enter", when: "fileTreeFocus" },

  // Inline rename for the focused file-tree row. `!inputFocus` prevents
  // double-fire when the rename/create edit row is already open.
  { command: COMMANDS.fileRename, primary: "F2", when: "fileTreeFocus && !inputFocus" },

  // Delete the focused file-tree row(s). Single Backspace gesture:
  //   - local workspace → move to Trash (recoverable).
  //   - SSH workspace   → permanent delete (no remote trash exists).
  // CRITICAL: `!inputFocus` is the data-loss guard for an open edit-row.
  {
    command: COMMANDS.fileDelete,
    primary: "Backspace",
    when: "fileTreeFocus && !inputFocus",
  },

  // File clipboard — cut/copy/paste. Scoped to file-tree focus, not in edit row.
  { command: COMMANDS.fileCopy, primary: "CmdOrCtrl+C", when: "fileTreeFocus && !inputFocus" },
  { command: COMMANDS.fileCut, primary: "CmdOrCtrl+X", when: "fileTreeFocus && !inputFocus" },
  { command: COMMANDS.filePaste, primary: "CmdOrCtrl+V", when: "fileTreeFocus && !inputFocus" },
  // Finder convention: Cmd+Option+V = Move Item Here (always move, no cut required).
  { command: COMMANDS.fileMoveHere, primary: "Cmd+Option+V", when: "fileTreeFocus && !inputFocus" },

  // Enter-triggered inline rename — Mac only (VSCode parity).
  // F2 is the universal rename key across all platforms.
  {
    command: COMMANDS.fileRenameByEnter,
    primary: "Enter",
    when: "fileTreeFocus && !inputFocus && isMac",
  },

  // Tabs
  { command: COMMANDS.tabClose, primary: "CmdOrCtrl+W" },
  { command: COMMANDS.tabCloseOthers, primary: "CmdOrCtrl+Alt+T" },
  // Chord-only commands (⌘K …). Cannot be Electron-registered;
  // renderer handles entirely.
  { command: COMMANDS.tabCloseSaved, chord: ["CmdOrCtrl+K", "U"] },
  { command: COMMANDS.tabCloseAll, chord: ["CmdOrCtrl+K", "CmdOrCtrl+W"] },
  // VSCode's binding holds Cmd through the chord (⌘K ⌘⇧↵).
  { command: COMMANDS.tabPinToggle, chord: ["CmdOrCtrl+K", "CmdOrCtrl+Shift+Enter"] },
  // Active-group tab cycling. Same Cmd+Ctrl modifier shape as
  // workspaceFocusPrev/Next (literal two-modifier combo, not CmdOrCtrl)
  // so Cmd-alone shortcuts inside Monaco aren't accidentally captured.
  { command: COMMANDS.tabFocusPrev, primary: "Cmd+Ctrl+Left" },
  { command: COMMANDS.tabFocusNext, primary: "Cmd+Ctrl+Right" },

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

  // Workspace navigation
  { command: COMMANDS.workspaceSymbolSearch, primary: "CmdOrCtrl+Shift+O" },
  // Cmd+Ctrl is a literal two-modifier combo (see keybinding-parse.ts);
  // intentionally not CmdOrCtrl so Cmd alone (used heavily by Monaco)
  // doesn't accidentally trigger workspace switching.
  { command: COMMANDS.workspaceFocusPrev, primary: "Cmd+Ctrl+Up" },
  { command: COMMANDS.workspaceFocusNext, primary: "Cmd+Ctrl+Down" },
  // ⌘⇧N opens the Add Workspace dialog.  Moved from ⌘N to free that
  // up for `file.new` (untitled buffer), matching VSCode's File ▸ New File
  // convention.
  { command: COMMANDS.workspaceAdd, primary: "CmdOrCtrl+Shift+N" },

  // Settings
  { command: COMMANDS.settingsOpen, primary: "CmdOrCtrl+," },

  // Workbench layout
  { command: COMMANDS.workbenchToggleFilesPanel, primary: "CmdOrCtrl+B" },
  { command: COMMANDS.workbenchToggleSidebar, primary: "CmdOrCtrl+Shift+B" },

  // Terminal
  { command: COMMANDS.terminalNew, primary: "CmdOrCtrl+T" },

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
