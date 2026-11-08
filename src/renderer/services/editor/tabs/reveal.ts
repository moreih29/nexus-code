import type * as Monaco from "monaco-editor";
import type { MonacoRange } from "../../../../shared/editor/monaco-range";

/**
 * Move the editor's selection/cursor to `range` and bring it into view.
 *
 * Order matters:
 *   1. focus()       — pulls keyboard focus from the search panel (or whatever
 *                      list invoked us) into the editor, unless the caller
 *                      asks for `preserveFocus` — as VSCode's
 *                      editorService.openEditor does. The nexus CLI asks: the
 *                      user may be typing in the terminal it ran from.
 *   2. setSelection — places the cursor at the range so subsequent keyboard
 *                      navigation starts at the match.
 *   3. revealRangeInCenter — scrolls the line to the viewport's center even
 *                      if it was already visible, mirroring VSCode's
 *                      `revealIfVisible: true`.
 */
export function revealRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
  preserveFocus = false,
): void {
  if (!preserveFocus) editor.focus();
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
}
