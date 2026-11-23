import { z } from "zod";

export const COMMANDS = {
  fileNew: "file.new",
  fileOpen: "file.open",
  fileSave: "file.save",
  filesRefresh: "files.refresh",
  openToSide: "explorer.openToSide",
  fileRename: "file.rename",
  fileDelete: "file.delete",
  fileCopy: "file.copy",
  fileCut: "file.cut",
  filePaste: "file.paste",
  fileMoveHere: "file.moveHere",
  fileRenameByEnter: "file.renameByEnter",

  tabClose: "tab.close",
  tabCloseOthers: "tab.closeOthers",
  tabCloseSaved: "tab.closeSaved",
  tabCloseAll: "tab.closeAll",
  tabPinToggle: "tab.pinToggle",
  tabFocusPrev: "tab.focusPrev",
  tabFocusNext: "tab.focusNext",

  groupSplitRight: "group.splitRight",
  groupSplitDown: "group.splitDown",
  groupClose: "group.close",
  groupFocusLeft: "group.focusLeft",
  groupFocusRight: "group.focusRight",
  groupFocusUp: "group.focusUp",
  groupFocusDown: "group.focusDown",

  workspaceSymbolSearch: "workspace.symbolSearch",
  peerWorkspaceQuickOpen: "workspace.peerQuickOpen",
  workspaceFocusPrev: "workspace.focusPrev",
  workspaceFocusNext: "workspace.focusNext",
  workspaceAdd: "workspace.add",
  taskNew: "task.new",
  sessionNextWaiting: "session.nextWaiting",

  chatVoiceToggle: "chat.voiceToggle",
  chatTogglePanel: "chat.togglePanel",

  settingsOpen: "settings.open",

  updatesCheck: "updates.check",
  updatesReleaseNotes: "updates.releaseNotes",

  workbenchToggleFilesPanel: "workbench.toggleFilesPanel",
  workbenchToggleSidebar: "workbench.toggleSidebar",
  workbenchToggleAgentView: "workbench.toggleAgentView",

  terminalNew: "terminal.new",

  browserFocusUrl: "browser.focusUrl",
  browserReload: "browser.reload",
  browserHardReload: "browser.hardReload",
  browserGoBack: "browser.goBack",
  browserGoForward: "browser.goForward",

  pathReveal: "path.reveal",
  pathCopy: "path.copy",
  pathCopyRelative: "path.copyRelative",
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS = Object.values(COMMANDS) as readonly CommandId[];

export const CommandIdSchema = z.enum(ALL_COMMAND_IDS as unknown as [CommandId, ...CommandId[]]);
