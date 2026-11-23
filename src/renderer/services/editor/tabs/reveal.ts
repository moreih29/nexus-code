import type * as Monaco from "monaco-editor";
import type { MonacoRange } from "../../../../shared/editor/monaco-range";

export function revealRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
  preserveFocus = false,
): void {
  if (!preserveFocus) editor.focus();
  editor.setSelection(range);
  centerWhileSettling(editor, range);
}

export const SETTLE_FRAMES = 10;

const settling = new WeakMap<Monaco.editor.IStandaloneCodeEditor, () => void>();

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
