import type * as Monaco from "monaco-editor";
import type { MonacoRange } from "../../../../shared/monaco-range";
import { takePendingEditorReveal } from "./pending-reveal";

export function revealRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  range: MonacoRange,
): void {
  editor.setSelection(range);
  editor.revealRangeInCenter(range);
}

export function applyPendingReveal(
  editor: Monaco.editor.IStandaloneCodeEditor,
  workspaceId: string,
  filePath: string,
): void {
  const range = takePendingEditorReveal({ workspaceId, filePath });
  if (!range) return;
  revealRange(editor, range);
}
