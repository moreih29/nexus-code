import type { AcceleratorString } from "./index";

export interface EditorCommandDef {
  id: string;
  slug: string;
  defaultPrimary?: AcceleratorString;
}

export const EDITOR_COMMANDS: readonly EditorCommandDef[] = [
  { id: "editor.action.commentLine", slug: "commentLine", defaultPrimary: "CmdOrCtrl+/" },
  { id: "editor.action.blockComment", slug: "blockComment", defaultPrimary: "Shift+Alt+A" },
  {
    id: "editor.action.addSelectionToNextFindMatch",
    slug: "addSelectionToNextFindMatch",
    defaultPrimary: "CmdOrCtrl+D",
  },
  {
    id: "editor.action.copyLinesDownAction",
    slug: "copyLinesDown",
    defaultPrimary: "Shift+Alt+Down",
  },
  { id: "editor.action.copyLinesUpAction", slug: "copyLinesUp", defaultPrimary: "Shift+Alt+Up" },
  { id: "editor.action.moveLinesDownAction", slug: "moveLinesDown", defaultPrimary: "Alt+Down" },
  { id: "editor.action.moveLinesUpAction", slug: "moveLinesUp", defaultPrimary: "Alt+Up" },
  { id: "editor.action.deleteLines", slug: "deleteLines", defaultPrimary: "CmdOrCtrl+Shift+K" },
  {
    id: "editor.action.insertCursorBelow",
    slug: "insertCursorBelow",
    defaultPrimary: "CmdOrCtrl+Alt+Down",
  },
  {
    id: "editor.action.insertCursorAbove",
    slug: "insertCursorAbove",
    defaultPrimary: "CmdOrCtrl+Alt+Up",
  },
  { id: "editor.action.formatDocument", slug: "formatDocument", defaultPrimary: "Shift+Alt+F" },
  { id: "editor.action.rename", slug: "rename", defaultPrimary: "F2" },
  { id: "editor.action.duplicateSelection", slug: "duplicateSelection" },
];

export const ALL_EDITOR_COMMAND_IDS: ReadonlySet<string> = new Set(
  EDITOR_COMMANDS.map((c) => c.id),
);

export function editorCommandDefault(id: string): AcceleratorString | null {
  return EDITOR_COMMANDS.find((c) => c.id === id)?.defaultPrimary ?? null;
}
