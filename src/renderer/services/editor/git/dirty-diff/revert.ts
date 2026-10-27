/**
 * Pure computation of the buffer edit that reverts one dirty-diff change —
 * VSCode's quick diff "Revert Change". Kept free of the monaco runtime so it
 * can be unit-tested against a minimal model shape.
 */

import type { DirtyChange } from "./types";

/** The slice of monaco's `ITextModel` the edit is computed against. */
export interface RevertTargetModel {
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
  getEOL(): string;
}

export interface RevertEdit {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
}

/**
 * The edit that puts `change`'s baseline lines back in place of its buffer
 * lines.
 *
 * An empty side is an insertion point: before its start line, or past the
 * last line when the start is one beyond it. Lines removed or added at the
 * end of the buffer take the line break before them along, so a file
 * without a trailing newline keeps none.
 *
 * @param originalLines  The baseline document split into lines.
 */
export function revertChangeEdit(
  change: DirtyChange,
  originalLines: readonly string[],
  model: RevertTargetModel,
): RevertEdit {
  const eol = model.getEOL();
  const lineCount = model.getLineCount();
  const restored =
    change.originalEndLineNumber === 0
      ? []
      : originalLines.slice(change.originalStartLineNumber - 1, change.originalEndLineNumber);
  const start = change.modifiedStartLineNumber;
  const end = change.modifiedEndLineNumber;

  if (end !== 0 && restored.length > 0) {
    return {
      range: range(start, 1, end, model.getLineMaxColumn(end)),
      text: restored.join(eol),
    };
  }

  if (end !== 0) {
    // Added lines: remove them along with one line break.
    if (end < lineCount) return { range: range(start, 1, end + 1, 1), text: "" };
    if (start > 1) {
      return {
        range: range(
          start - 1,
          model.getLineMaxColumn(start - 1),
          end,
          model.getLineMaxColumn(end),
        ),
        text: "",
      };
    }
    return { range: range(1, 1, end, model.getLineMaxColumn(end)), text: "" };
  }

  // Deleted lines: insert them back at the gap.
  if (start <= lineCount) {
    return { range: range(start, 1, start, 1), text: `${restored.join(eol)}${eol}` };
  }
  const lastColumn = model.getLineMaxColumn(lineCount);
  return {
    range: range(lineCount, lastColumn, lineCount, lastColumn),
    text: `${eol}${restored.join(eol)}`,
  };
}

function range(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): RevertEdit["range"] {
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}
