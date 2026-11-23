import type { MonacoRange } from "../../../../shared/editor/monaco-range";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "../types";
import { openOrRevealEditor } from "./open-editor";
import { requestEditorReveal } from "./pending-reveal";

export interface RevealEditorAtOptions extends OpenEditorOptions {
  selection?: MonacoRange;
}

export function revealEditorAt(
  input: EditorInput,
  options: RevealEditorAtOptions = {},
): EditorTabLocation {
  const { selection, ...openOpts } = options;
  const location = openOrRevealEditor(input, openOpts);
  if (selection) {
    requestEditorReveal({ ...input, range: selection, tabId: location.tabId });
  }
  return location;
}
