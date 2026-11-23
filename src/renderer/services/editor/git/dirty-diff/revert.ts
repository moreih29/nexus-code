import type { DirtyChange } from "./types";

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
