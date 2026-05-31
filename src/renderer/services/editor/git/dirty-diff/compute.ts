/**
 * Line-level diff computation for the dirty-diff gutter.
 *
 * We reuse Monaco's own diff engine (`DefaultLinesDiffComputer`) rather than
 * bundling a separate diff library or spawning a hidden diff editor. It is the
 * exact algorithm VSCode's quick-diff uses, ships inside the `monaco-editor`
 * package we already depend on, and is a pure function over two `string[]`
 * inputs — no editor instance or worker plumbing required.
 *
 * The deep import path reaches into monaco's internal ESM tree. It is stable
 * (this module has lived at the same path across many monaco releases) and only
 * pulls in core range/diff utilities, not the full editor, so it stays cheap.
 */

import { linesDiffComputers } from "monaco-editor/esm/vs/editor/common/diff/linesDiffComputers";
import { mapChangesToDirty } from "./map";
import type { DirtyChange } from "./types";

/** Matches VSCode's quick-diff budget: abandon diffs that take too long. */
const MAX_COMPUTATION_TIME_MS = 1000;

const computer = linesDiffComputers.getDefault();

/**
 * Splits text into lines the way Monaco's `TextModel.getLinesContent()` does —
 * the diff computer expects one array element per logical line with no trailing
 * newline characters. A trailing newline therefore yields a final empty string,
 * which is correct (the document has an empty last line).
 */
function toLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Computes the contiguous change regions between the HEAD baseline and the
 * current buffer.
 *
 * @param originalText  HEAD blob content (the baseline).
 * @param modifiedText  Current editor buffer content.
 * @param ignoreTrimWhitespace  When true, leading/trailing whitespace-only
 *   differences are ignored (mirrors `diffEditor.ignoreTrimWhitespace`).
 * @returns Changes ordered by position, classified add/modify/delete, with
 *   1-based inclusive Monaco-style line numbers. Empty when identical.
 */
export function computeDirtyChanges(
  originalText: string,
  modifiedText: string,
  ignoreTrimWhitespace = true,
): DirtyChange[] {
  if (originalText === modifiedText) return [];

  const result = computer.computeDiff(toLines(originalText), toLines(modifiedText), {
    computeMoves: false,
    ignoreTrimWhitespace,
    maxComputationTimeMs: MAX_COMPUTATION_TIME_MS,
  });

  return mapChangesToDirty(result.changes);
}
