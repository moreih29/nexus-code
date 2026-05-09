import type { MonacoRange } from "../../../../shared/monaco-range";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "../types";
import { openOrRevealEditor } from "./open-editor";
import { requestEditorReveal } from "./pending-reveal";

/**
 * Atomic "open this editor and put the cursor at this range" call — the
 * single entry point used by search-match clicks, the workspace-symbol
 * palette, and any other navigation surface that wants VSCode-style
 * `editorService.openEditor({ resource, options: { selection } })`
 * semantics.
 *
 * Why a single function rather than two calls at every call site:
 *   The earlier API split this into `openOrRevealEditor(...)` followed by
 *   `requestEditorReveal(...)`. Every caller had to remember to do both,
 *   in order, and the contract of "Monaco may not be mounted yet, so the
 *   range is queued and flushed by the registry on mount" was leaked into
 *   each call site. Combining them makes the contract a hidden detail of
 *   this module and makes a whole class of "I forgot to call the second
 *   half" bugs impossible.
 *
 * Behaviour:
 *   1. Open or reveal the tab via `openOrRevealEditor` (preview-slot reuse,
 *      newSplit, etc. are forwarded through `options`).
 *   2. If `selection` is supplied, hand it to `requestEditorReveal`. When
 *      a registered editor exists (the typical case for an already-open
 *      file), this calls `revealRange` synchronously. Otherwise the range
 *      is queued and the next `registerRevealTarget` for this key flushes
 *      it — covers the click-then-mount path for fresh tabs.
 */
export interface RevealEditorAtOptions extends OpenEditorOptions {
  /**
   * Selection / cursor range to apply once the editor is the active reveal
   * target. Omit for "just open the file, no specific position" gestures
   * (e.g. file-tree single-click).
   */
  selection?: MonacoRange;
}

export function revealEditorAt(
  input: EditorInput,
  options: RevealEditorAtOptions = {},
): EditorTabLocation {
  const { selection, ...openOpts } = options;
  const location = openOrRevealEditor(input, openOpts);
  if (selection) {
    requestEditorReveal({ ...input, range: selection });
  }
  return location;
}
