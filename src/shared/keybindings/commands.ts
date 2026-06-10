/**
 * Application command catalog.
 *
 * Both the Application Menu (main process) and the renderer's keyboard
 * dispatcher route through these IDs. Each ID maps to exactly one
 * runtime handler that is registered in the renderer command registry.
 *
 * Adding a new shortcut means: declare an ID here → register a handler
 * in the renderer (a `keybindings/commands/<domain>-commands.ts` module,
 * composed by `use-global-keybindings.ts`) → optionally surface it in the
 * menu template and/or the keyboard dispatcher.
 *
 * IDs are namespaced by surface (`file.*`, `tab.*`, `group.*`,
 * `path.*`) so the catalog stays scannable as the app grows.
 */
import { z } from "zod";

export const COMMANDS = {
  // File / editor
  fileNew: "file.new",
  fileOpen: "file.open",
  fileSave: "file.save",
  filesRefresh: "files.refresh",
  // Opens the focused file-tree row in a side split (VSCode parity:
  // explorer-only, scoped via `when: "fileTreeFocus"`).
  openToSide: "explorer.openToSide",
  // Inline rename for the focused file-tree row. Scoped via
  // `when: "fileTreeFocus && !inputFocus"` — does not fire while an
  // edit row (create/rename input) is already active.
  fileRename: "file.rename",
  // Delete the focused file-tree row(s). Cmd+Backspace (macOS Finder parity):
  //   - local workspace → OS Trash (recoverable).
  //   - SSH workspace   → permanent delete (no remote trash exists).
  // Plain Backspace does NOT delete — it is reserved for text editing
  // everywhere else on the platform and a single-keystroke delete would
  // be too easy to trigger by accident.
  // Scoped via `when: "fileTreeFocus && !inputFocus"` — CRITICAL: the
  // `!inputFocus` condition prevents the edit-row (create/rename input)
  // from accidentally deleting the parent row mid-typing.
  fileDelete: "file.delete",
  // File clipboard cut/copy/paste (Mac: Cmd+Option+V = Move Item Here).
  fileCopy: "file.copy",
  fileCut: "file.cut",
  filePaste: "file.paste",
  fileMoveHere: "file.moveHere",
  // Enter-triggered rename — Mac only (VSCode parity). On Windows/Linux
  // Enter opens the file; rename is F2 on all platforms.
  fileRenameByEnter: "file.renameByEnter",

  // Tabs
  tabClose: "tab.close",
  tabCloseOthers: "tab.closeOthers",
  // Chord-only commands (⌘K …) — see the KEYBINDINGS table in ./index.ts.
  tabCloseSaved: "tab.closeSaved",
  tabCloseAll: "tab.closeAll",
  tabPinToggle: "tab.pinToggle",
  // Cycle the active tab one slot left/right inside the active group's
  // tabIds (wraps at both ends, no-op when the group has ≤1 tabs).
  tabFocusPrev: "tab.focusPrev",
  tabFocusNext: "tab.focusNext",

  // Groups (panels)
  groupSplitRight: "group.splitRight",
  groupSplitDown: "group.splitDown",
  groupClose: "group.close",
  groupFocusLeft: "group.focusLeft",
  groupFocusRight: "group.focusRight",
  groupFocusUp: "group.focusUp",
  groupFocusDown: "group.focusDown",

  // Workspace navigation
  workspaceSymbolSearch: "workspace.symbolSearch",
  // Cycle the active workspace one slot up/down in the sidebar order
  // (pinned rows float above unpinned; wrap-around at both ends).
  workspaceFocusPrev: "workspace.focusPrev",
  workspaceFocusNext: "workspace.focusNext",
  // Open the Add Workspace dialog.
  workspaceAdd: "workspace.add",

  // Settings
  settingsOpen: "settings.open",

  // Updates — dispatched directly to the main-process updates domain
  // (never forwarded to the renderer via IPC).
  updatesCheck: "updates.check",

  // Workbench layout toggles
  // ⌘B = files panel only; ⌘⇧B = both columns (VSCode-style full sidebar).
  workbenchToggleFilesPanel: "workbench.toggleFilesPanel",
  workbenchToggleSidebar: "workbench.toggleSidebar",

  // NOTE: DevTools has no app keybinding command. ⌘⌥I is owned by the
  // Electron menu `toggleDevTools` role (app-window DevTools, standard
  // behavior). A browser PAGE's DevTools is opened from the panel's
  // toolbar button only — a reliable keyboard shortcut isn't feasible
  // because the menu role preempts ⌘⌥I at the OS level for the focused
  // window's webContents (the app), never the embedded page.

  // Terminal
  terminalNew: "terminal.new",

  // Browser tab (embedded WebContentsView). All are scoped via
  // `when: "browserTabActive"` — they act on the active group's active
  // tab when (and only when) that tab is a browser tab. Previously these
  // were hardcoded capture-phase listeners inside browser-view.tsx, which
  // (a) could not be customized or conflict-checked, and (b) lost the
  // ⌘R/⌘⇧R race against the global dispatcher (files.refresh fired and
  // stopImmediatePropagation'd before the component listener ran).
  browserFocusUrl: "browser.focusUrl",
  browserReload: "browser.reload",
  browserHardReload: "browser.hardReload",
  browserGoBack: "browser.goBack",
  browserGoForward: "browser.goForward",

  // Path actions on the active editor (mirrors VSCode's "when editor not focused")
  pathReveal: "path.reveal",
  pathCopy: "path.copy",
  pathCopyRelative: "path.copyRelative",
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS = Object.values(COMMANDS) as readonly CommandId[];

export const CommandIdSchema = z.enum(ALL_COMMAND_IDS as unknown as [CommandId, ...CommandId[]]);
