import { COMMANDS, type CommandId } from "./commands";
import { parseAccelerator } from "./keybinding-parse";
import { evaluateWhen, PLATFORM_KEYS, parseWhen, type WhenExpr, whenKeys } from "./keybinding-when";

export type AcceleratorString = string;

export interface KeybindingDecl {
  command: CommandId;
  primary?: AcceleratorString;
  chord?: readonly [AcceleratorString, AcceleratorString];
  when?: string;
}

const UNLESS_TERMINAL = "!terminalFocus || isMac";

export const KEYBINDINGS: readonly KeybindingDecl[] = [
  { command: COMMANDS.fileNew, primary: "CmdOrCtrl+N", when: UNLESS_TERMINAL },
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+E", when: UNLESS_TERMINAL },
  { command: COMMANDS.fileOpen, primary: "CmdOrCtrl+O", when: UNLESS_TERMINAL },
  { command: COMMANDS.fileSave, primary: "CmdOrCtrl+S", when: UNLESS_TERMINAL },
  {
    command: COMMANDS.filesRefresh,
    primary: "CmdOrCtrl+R",
    when: `!browserTabActive && (${UNLESS_TERMINAL})`,
  },
  { command: COMMANDS.filesRefresh, primary: "CmdOrCtrl+Shift+R", when: "!browserTabActive" },

  { command: COMMANDS.openToSide, primary: "CmdOrCtrl+Enter", when: "fileTreeFocus" },

  { command: COMMANDS.fileRename, primary: "F2", when: "fileTreeFocus && !inputFocus" },

  {
    command: COMMANDS.fileDelete,
    primary: "Cmd+Backspace",
    when: "fileTreeFocus && !inputFocus",
  },
  {
    command: COMMANDS.fileDelete,
    primary: "Delete",
    when: "fileTreeFocus && !inputFocus && !isMac",
  },

  { command: COMMANDS.fileCopy, primary: "CmdOrCtrl+C", when: "fileTreeFocus && !inputFocus" },
  { command: COMMANDS.fileCut, primary: "CmdOrCtrl+X", when: "fileTreeFocus && !inputFocus" },
  { command: COMMANDS.filePaste, primary: "CmdOrCtrl+V", when: "fileTreeFocus && !inputFocus" },
  { command: COMMANDS.fileMoveHere, primary: "Cmd+Option+V", when: "fileTreeFocus && !inputFocus" },

  {
    command: COMMANDS.fileRenameByEnter,
    primary: "Enter",
    when: "fileTreeFocus && !inputFocus && isMac",
  },

  { command: COMMANDS.tabClose, primary: "CmdOrCtrl+W", when: UNLESS_TERMINAL },
  { command: COMMANDS.tabClose, primary: "Ctrl+F4", when: "!isMac" },
  { command: COMMANDS.tabCloseOthers, primary: "CmdOrCtrl+Alt+T" },
  { command: COMMANDS.tabCloseSaved, chord: ["CmdOrCtrl+K", "U"], when: UNLESS_TERMINAL },
  { command: COMMANDS.tabCloseAll, chord: ["CmdOrCtrl+K", "CmdOrCtrl+W"], when: UNLESS_TERMINAL },
  {
    command: COMMANDS.tabPinToggle,
    chord: ["CmdOrCtrl+K", "CmdOrCtrl+Shift+Enter"],
    when: UNLESS_TERMINAL,
  },
  { command: COMMANDS.tabFocusPrev, primary: "Cmd+Ctrl+Left" },
  { command: COMMANDS.tabFocusNext, primary: "Cmd+Ctrl+Right" },
  { command: COMMANDS.tabFocusPrev, primary: "Ctrl+PageUp", when: "!isMac" },
  { command: COMMANDS.tabFocusNext, primary: "Ctrl+PageDown", when: "!isMac" },

  { command: COMMANDS.groupSplitRight, primary: "CmdOrCtrl+\\", when: UNLESS_TERMINAL },
  { command: COMMANDS.groupSplitDown, primary: "CmdOrCtrl+Shift+\\" },
  { command: COMMANDS.groupClose, primary: "CmdOrCtrl+Shift+W" },
  { command: COMMANDS.groupFocusLeft, primary: "CmdOrCtrl+Alt+Left" },
  { command: COMMANDS.groupFocusRight, primary: "CmdOrCtrl+Alt+Right" },
  { command: COMMANDS.groupFocusUp, primary: "CmdOrCtrl+Alt+Up" },
  { command: COMMANDS.groupFocusDown, primary: "CmdOrCtrl+Alt+Down" },

  { command: COMMANDS.workspaceSymbolSearch, primary: "CmdOrCtrl+Shift+O" },
  {
    command: COMMANDS.peerWorkspaceQuickOpen,
    primary: "CmdOrCtrl+P",
    when: `peerWorkspaceActive && (${UNLESS_TERMINAL})`,
  },
  { command: COMMANDS.workspaceFocusPrev, primary: "Cmd+Ctrl+Up" },
  { command: COMMANDS.workspaceFocusNext, primary: "Cmd+Ctrl+Down" },
  { command: COMMANDS.workspaceAdd, primary: "CmdOrCtrl+Shift+N" },
  { command: COMMANDS.sessionNextWaiting, primary: "CmdOrCtrl+Shift+U", when: "!isLinux" },
  { command: COMMANDS.sessionNextWaiting, primary: "Ctrl+Shift+J", when: "isLinux" },

  { command: COMMANDS.chatVoiceToggle, primary: "CmdOrCtrl+Shift+D" },
  { command: COMMANDS.chatTogglePanel, primary: "CmdOrCtrl+Shift+]", when: "chatPanelActive" },

  { command: COMMANDS.settingsOpen, primary: "CmdOrCtrl+," },

  { command: COMMANDS.workbenchToggleFilesPanel, primary: "CmdOrCtrl+B", when: UNLESS_TERMINAL },
  { command: COMMANDS.workbenchToggleSidebar, primary: "CmdOrCtrl+Shift+B" },
  { command: COMMANDS.workbenchToggleAgentView, primary: "CmdOrCtrl+Shift+A" },

  { command: COMMANDS.terminalNew, primary: "CmdOrCtrl+T", when: UNLESS_TERMINAL },
  { command: COMMANDS.terminalNew, primary: "Ctrl+Shift+T", when: "!isMac" },

  { command: COMMANDS.browserFocusUrl, primary: "CmdOrCtrl+L", when: "browserTabActive" },
  { command: COMMANDS.browserReload, primary: "CmdOrCtrl+R", when: "browserTabActive" },
  { command: COMMANDS.browserHardReload, primary: "CmdOrCtrl+Shift+R", when: "browserTabActive" },
  { command: COMMANDS.browserGoBack, primary: "CmdOrCtrl+[", when: "browserTabActive" },
  { command: COMMANDS.browserGoForward, primary: "CmdOrCtrl+]", when: "browserTabActive" },

  { command: COMMANDS.pathReveal, primary: "CmdOrCtrl+Alt+R" },
  { command: COMMANDS.pathCopy, primary: "CmdOrCtrl+Alt+C" },
  { command: COMMANDS.pathCopyRelative, primary: "CmdOrCtrl+Shift+Alt+C" },
];

export function findPrimaryBinding(command: CommandId): KeybindingDecl | undefined {
  return KEYBINDINGS.find((k) => k.command === command && k.primary !== undefined);
}

export function findChordBinding(command: CommandId): KeybindingDecl | undefined {
  return KEYBINDINGS.find((k) => k.command === command && k.chord !== undefined);
}

export function findDisplayPrimary(
  bindings: readonly KeybindingDecl[],
  command: string,
  isMac: boolean,
  isLinux = false,
): KeybindingDecl | undefined {
  const declared = bindings.filter((b) => b.command === command && b.primary !== undefined);
  const scope = (b: KeybindingDecl) => platformScope(b.when, isMac, isLinux);
  const here = declared.filter((b) => scope(b) !== false);
  const primaries = here.length > 0 ? here : declared;
  if (isMac) return primaries[0];
  const usable = primaries.filter((b) => !needsSuperKey(b.primary as string));
  const pick = (list: KeybindingDecl[]) => list.find((b) => !leavesTerminalToShell(b)) ?? list[0];
  return pick(usable.filter((b) => scope(b) === true)) ?? pick(usable) ?? primaries[0];
}

function platformScope(
  when: string | undefined,
  isMac: boolean,
  isLinux: boolean,
): boolean | undefined {
  if (when === undefined) return undefined;
  const platform: Record<string, boolean> = { isMac, isLinux, isWindows: !isMac && !isLinux };
  const parts = conjuncts(parseWhen(when)).filter((part) =>
    whenKeys(part).every((key) => PLATFORM_KEYS.has(key)),
  );
  if (parts.length === 0) return undefined;
  return parts.every((part) => evaluateWhen(part, (key) => platform[key] === true));
}

function conjuncts(expr: WhenExpr): WhenExpr[] {
  return expr.kind === "and" ? [...conjuncts(expr.left), ...conjuncts(expr.right)] : [expr];
}

function leavesTerminalToShell(binding: KeybindingDecl): boolean {
  return binding.when?.includes("!terminalFocus") === true;
}

function needsSuperKey(accel: AcceleratorString): boolean {
  try {
    const p = parseAccelerator(accel);
    return p.cmd && p.ctrl;
  } catch {
    return false;
  }
}
