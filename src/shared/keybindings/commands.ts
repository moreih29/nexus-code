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
  // Delete the focused file-tree row (Delete / Backspace). Scoped via
  // `when: "fileTreeFocus && !inputFocus"` — CRITICAL: `!inputFocus` 조건이
  // 없으면 edit-row 입력 도중 Delete가 부모 행 삭제를 유발해 데이터 손실.
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

  // Terminal
  terminalNew: "terminal.new",

  // Path actions on the active editor (mirrors VSCode's "when editor not focused")
  pathReveal: "path.reveal",
  pathCopy: "path.copy",
  pathCopyRelative: "path.copyRelative",
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS = Object.values(COMMANDS) as readonly CommandId[];

export const CommandIdSchema = z.enum(ALL_COMMAND_IDS as unknown as [CommandId, ...CommandId[]]);
