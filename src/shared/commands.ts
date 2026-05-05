/**
 * Application command catalog.
 *
 * Both the Application Menu (main process) and the renderer's keyboard
 * dispatcher route through these IDs. Each ID maps to exactly one
 * runtime handler that is registered in the renderer command registry.
 *
 * Adding a new shortcut means: declare an ID here → register a handler
 * in the renderer (`use-global-commands.ts`) → optionally surface it in
 * the menu template and/or the keyboard dispatcher.
 *
 * IDs are namespaced by surface (`file.*`, `tab.*`, `group.*`,
 * `path.*`) so the catalog stays scannable as the app grows.
 */
import { z } from "zod";

export const COMMANDS = {
  // File / editor
  fileOpen: "file.open",
  fileSave: "file.save",
  filesRefresh: "files.refresh",

  // Tabs
  tabClose: "tab.close",
  tabCloseOthers: "tab.closeOthers",

  // Groups (panels)
  groupSplitRight: "group.splitRight",
  groupSplitDown: "group.splitDown",
  groupClose: "group.close",
  groupFocusLeft: "group.focusLeft",
  groupFocusRight: "group.focusRight",
  groupFocusUp: "group.focusUp",
  groupFocusDown: "group.focusDown",

  // Path actions on the active editor (mirrors VSCode's "when editor not focused")
  pathReveal: "path.reveal",
  pathCopy: "path.copy",
  pathCopyRelative: "path.copyRelative",
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS = Object.values(COMMANDS) as readonly CommandId[];

export const CommandIdSchema = z.enum(ALL_COMMAND_IDS as unknown as [CommandId, ...CommandId[]]);
