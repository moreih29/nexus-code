/**
 * Curated catalog of user-rebindable Monaco editor commands (Stage 3,
 * "B안 큐레이션").
 *
 * Why a curated list instead of mirroring Monaco's full ~600-command
 * registry: Monaco exposes no clean enumeration API, its when-clause
 * context system is its own, and 99% of those commands are never
 * rebound. We surface the handful people actually remap (comment, move/
 * copy line, multi-cursor, format, …) plus an "advanced: bind any
 * command id" escape hatch in the UI for the long tail.
 *
 * These commands are NOT part of the app dispatcher's KEYBINDINGS table —
 * they live entirely inside Monaco's own keybinding service and only fire
 * while the editor has focus. Customization is applied at the Monaco
 * layer via `monaco.editor.addKeybindingRules` (see the renderer
 * `services/editor/keybindings/apply.ts` reconciler), persisted as a
 * separate `editorKeybindingOverrides` delta, and reuses the SAME
 * override schema (command id + primary accelerator) as app keybindings.
 *
 * `defaultPrimary` records Monaco's built-in default in OUR accelerator
 * format (CmdOrCtrl resolves per-platform, mirroring Monaco's CtrlCmd).
 * It serves two jobs: showing "Default" in the UI, and telling the
 * reconciler which keystroke to UNBIND when the user replaces it. A
 * command that ships unbound (e.g. duplicateSelection) omits it.
 *
 * `slug` is the i18n label key suffix — flat (`editorCommand.<slug>`)
 * because the raw ids contain dots that i18next would treat as nesting.
 */

import type { AcceleratorString } from "./index";

export interface EditorCommandDef {
  /** Monaco command id, passed verbatim to addKeybindingRules. */
  id: string;
  /** i18n key suffix: `keybindings.editorCommand.<slug>`. */
  slug: string;
  /** Monaco's built-in default in our accelerator format; absent = ships unbound. */
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
  // Ships unbound in Monaco standalone — a popular candidate for a user binding.
  { id: "editor.action.duplicateSelection", slug: "duplicateSelection" },
];

export const ALL_EDITOR_COMMAND_IDS: ReadonlySet<string> = new Set(
  EDITOR_COMMANDS.map((c) => c.id),
);

/** Look up a curated command's declared default keystroke (or null). */
export function editorCommandDefault(id: string): AcceleratorString | null {
  return EDITOR_COMMANDS.find((c) => c.id === id)?.defaultPrimary ?? null;
}
