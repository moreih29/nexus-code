import type { AcceleratorString } from "./index";
import { normalizeKeystroke } from "./keybinding-parse";

export type ReservedKeySource = "system" | "electron" | "monaco" | "terminal";

export interface ReservedKey {
  accelerator: AcceleratorString;
  source: ReservedKeySource;
  noteKey: string;
  platform?: "mac" | "non-mac";
}

export const RESERVED_KEYS: readonly ReservedKey[] = [
  { accelerator: "Cmd+Q", source: "system", noteKey: "quitApplication", platform: "mac" },
  { accelerator: "Cmd+H", source: "system", noteKey: "hideApplication", platform: "mac" },
  { accelerator: "Cmd+Alt+H", source: "system", noteKey: "hideOthers", platform: "mac" },
  { accelerator: "Cmd+M", source: "system", noteKey: "minimizeWindow", platform: "mac" },

  { accelerator: "CmdOrCtrl+C", source: "electron", noteKey: "copy" },
  { accelerator: "CmdOrCtrl+X", source: "electron", noteKey: "cut" },
  { accelerator: "CmdOrCtrl+V", source: "electron", noteKey: "paste" },
  { accelerator: "CmdOrCtrl+A", source: "electron", noteKey: "selectAll" },
  { accelerator: "CmdOrCtrl+Z", source: "electron", noteKey: "undo" },
  { accelerator: "CmdOrCtrl+Shift+Z", source: "electron", noteKey: "redo" },
  { accelerator: "CmdOrCtrl+Alt+I", source: "electron", noteKey: "toggleDevTools" },
  { accelerator: "CmdOrCtrl+0", source: "electron", noteKey: "resetZoom" },
  { accelerator: "CmdOrCtrl+-", source: "electron", noteKey: "zoomOut" },
  { accelerator: "CmdOrCtrl+=", source: "electron", noteKey: "zoomIn" },

  { accelerator: "CmdOrCtrl+/", source: "monaco", noteKey: "toggleLineComment" },
  { accelerator: "CmdOrCtrl+D", source: "monaco", noteKey: "addNextMatch" },
  { accelerator: "CmdOrCtrl+F", source: "monaco", noteKey: "find" },
  { accelerator: "CmdOrCtrl+Alt+F", source: "monaco", noteKey: "replace" },
  { accelerator: "CmdOrCtrl+G", source: "monaco", noteKey: "findNext" },
  { accelerator: "CmdOrCtrl+U", source: "monaco", noteKey: "undoCursor" },
  { accelerator: "CmdOrCtrl+[", source: "monaco", noteKey: "outdent" },
  { accelerator: "CmdOrCtrl+]", source: "monaco", noteKey: "indent" },
  { accelerator: "CmdOrCtrl+Shift+K", source: "monaco", noteKey: "deleteLine" },
  { accelerator: "CmdOrCtrl+Enter", source: "monaco", noteKey: "insertLineBelow" },
  { accelerator: "Alt+Up", source: "monaco", noteKey: "moveLineUp" },
  { accelerator: "Alt+Down", source: "monaco", noteKey: "moveLineDown" },
  { accelerator: "Shift+Alt+Up", source: "monaco", noteKey: "copyLineUp" },
  { accelerator: "Shift+Alt+Down", source: "monaco", noteKey: "copyLineDown" },
  { accelerator: "F1", source: "monaco", noteKey: "editorPalette" },
  { accelerator: "F8", source: "monaco", noteKey: "nextProblem" },
  { accelerator: "F12", source: "monaco", noteKey: "definition" },
  { accelerator: "Shift+F12", source: "monaco", noteKey: "references" },

  { accelerator: "Ctrl+C", source: "terminal", noteKey: "interrupt" },
  { accelerator: "Ctrl+D", source: "terminal", noteKey: "shellEof" },
  { accelerator: "Ctrl+Z", source: "terminal", noteKey: "suspendJob" },
  { accelerator: "Ctrl+R", source: "terminal", noteKey: "reverseSearch" },
  { accelerator: "Ctrl+A", source: "terminal", noteKey: "lineStart" },
  { accelerator: "Ctrl+E", source: "terminal", noteKey: "lineEnd" },
  { accelerator: "Ctrl+W", source: "terminal", noteKey: "deletePreviousWord" },
  { accelerator: "Ctrl+U", source: "terminal", noteKey: "killLineBackward" },
  { accelerator: "Ctrl+K", source: "terminal", noteKey: "killLineForward" },
  { accelerator: "Ctrl+L", source: "terminal", noteKey: "clearScreen" },
  { accelerator: "Ctrl+T", source: "terminal", noteKey: "transpose" },
  { accelerator: "Ctrl+N", source: "terminal", noteKey: "nextHistory" },
  { accelerator: "Ctrl+P", source: "terminal", noteKey: "previousHistory" },
  { accelerator: "Ctrl+O", source: "terminal", noteKey: "operateNext" },
  { accelerator: "Ctrl+S", source: "terminal", noteKey: "flowStop" },
  { accelerator: "Ctrl+Q", source: "terminal", noteKey: "flowResume" },
  { accelerator: "Ctrl+\\", source: "terminal", noteKey: "sigquit" },
  { accelerator: "Shift+Enter", source: "terminal", noteKey: "multiline" },
];

export function findReservedKey(accel: AcceleratorString, isMac: boolean): ReservedKey | undefined {
  const norm = normalizeKeystroke(accel, isMac);
  if (norm === null) return undefined;
  return RESERVED_KEYS.find((r) => {
    if (r.platform === "mac" && !isMac) return false;
    if (r.platform === "non-mac" && isMac) return false;
    return normalizeKeystroke(r.accelerator, isMac) === norm;
  });
}
