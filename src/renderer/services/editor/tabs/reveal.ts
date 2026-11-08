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
 *                      `revealIfVisible: true`. It centers again while the
 *                      editor settles into its height (see `centerWhileSettling`).
 */
export function revealRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
  preserveFocus = false,
): void {
  if (!preserveFocus) editor.focus();
  editor.setSelection(range);
  centerWhileSettling(editor, range);
}

/** How many frames an editor may take to settle into its height. */
export const SETTLE_FRAMES = 10;

/** Each editor's re-centering in progress, ended by a newer reveal. */
const settling = new WeakMap<Monaco.editor.IStandaloneCodeEditor, () => void>();

/**
 * Centers `range` now, and again whenever the editor's height changes over
 * the next few frames. An editor that mounts in a group just split off is
 * laid out at a sliver first and at its height a frame later: centered in
 * the sliver, the line would end up at the top.
 */
function centerWhileSettling(editor: Monaco.editor.IStandaloneCodeEditor, range: MonacoRange) {
  settling.get(editor)?.();
  editor.revealRangeInCenter(range);
  let height = editor.getLayoutInfo().height;
  const listener = editor.onDidLayoutChange((layout) => {
    if (layout.height === height) return;
    height = layout.height;
    editor.revealRangeInCenter(range);
  });
  let left = SETTLE_FRAMES;
  const end = () => {
    left = 0;
    listener.dispose();
    if (settling.get(editor) === end) settling.delete(editor);
  };
  settling.set(editor, end);
  const count = () => {
    if (left === 0) return;
    left -= 1;
    if (left === 0) end();
    else requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
}
