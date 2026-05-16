import type * as Monaco from "monaco-editor";
import type { MonacoRange } from "../../../../shared/editor/monaco-range";

/**
 * Move the editor's selection/cursor to `range` and bring it into view.
 *
 * Order matters:
 *   1. focus()       — pulls keyboard focus from the search panel (or whatever
 *                      list invoked us) into the editor. Without this, Monaco
 *                      treats follow-up reveals on an unfocused editor as
 *                      lower-priority and viewport changes can be skipped or
 *                      coalesced away. Matches VSCode's editorService.openEditor
 *                      semantics, which only preserve focus when the caller
 *                      asks for `preserveFocus: true`.
 *   2. setSelection — places the cursor at the range so subsequent keyboard
 *                      navigation starts at the match.
 *   3. revealRangeInCenter — scrolls the line to the viewport's center even
 *                      if it was already visible, mirroring VSCode's
 *                      `revealIfVisible: true`.
 */
export function revealRange(editor: Monaco.editor.IStandaloneCodeEditor, range: MonacoRange): void {
  editor.focus();
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
}
