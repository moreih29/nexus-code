import type { DirtyChange } from "../dirty-diff/types";

export interface LineRange {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
}

export interface LineChange {
  readonly original: LineRange;
  readonly modified: LineRange;
}

export interface MonacoLineChangeLike {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

function lineRange(startLineNumber: number, endLineNumberExclusive: number): LineRange {
  return { startLineNumber, endLineNumberExclusive };
}

function isEmpty(range: LineRange): boolean {
  return range.startLineNumber === range.endLineNumberExclusive;
}

export function lineChangeOfDirty(change: DirtyChange): LineChange {
  const side = (start: number, end: number) => lineRange(start, end === 0 ? start : end + 1);
  return {
    original: side(change.originalStartLineNumber, change.originalEndLineNumber),
    modified: side(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
  };
}

export function lineChangeOfMonaco(change: MonacoLineChangeLike): LineChange {
  const side = (start: number, end: number) =>
    end === 0 ? lineRange(start + 1, start + 1) : lineRange(start, end + 1);
  return {
    original: side(change.originalStartLineNumber, change.originalEndLineNumber),
    modified: side(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
  };
}

export function invertLineChange(change: LineChange): LineChange {
  return { original: change.modified, modified: change.original };
}

export function intersectLineChange(change: LineChange, range: LineRange): LineChange | null {
  const { original, modified } = change;
  if (isEmpty(modified)) {
    const gap = modified.startLineNumber;
    return range.startLineNumber <= gap && gap <= range.endLineNumberExclusive ? change : null;
  }
  const start = Math.max(modified.startLineNumber, range.startLineNumber);
  const end = Math.min(modified.endLineNumberExclusive, range.endLineNumberExclusive);
  if (start >= end) return null;
  if (start === modified.startLineNumber && end === modified.endLineNumberExclusive) return change;

  const originalLength = original.endLineNumberExclusive - original.startLineNumber;
  const modifiedLength = modified.endLineNumberExclusive - modified.startLineNumber;
  if (originalLength !== modifiedLength) return { original, modified: lineRange(start, end) };
  const from = original.startLineNumber + (start - modified.startLineNumber);
  return { original: lineRange(from, from + (end - start)), modified: lineRange(start, end) };
}

export function selectChanges(
  changes: readonly LineChange[],
  ranges: readonly LineRange[],
): LineChange[] {
  const selected: LineChange[] = [];
  for (const change of changes) {
    for (const range of ranges) {
      const part = intersectLineChange(change, range);
      if (part) {
        selected.push(part);
        break;
      }
    }
  }
  return selected;
}

export function splitLines(text: string): { lines: string[]; breaks: string[] } {
  const lines: string[] = [];
  const breaks: string[] = [];
  const lineBreak = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
    lines.push(text.slice(start, match.index));
    breaks.push(match[0]);
    start = match.index + match[0].length;
  }
  lines.push(text.slice(start));
  return { lines, breaks };
}

export function applyLineChanges(
  original: string,
  modifiedLines: readonly string[],
  changes: readonly LineChange[],
  fallbackEol: string,
): string {
  const { lines, breaks } = splitLines(original);
  const eol = breaks[0] ?? fallbackEol;
  const out: string[] = [];
  const outBreaks: string[] = [];
  const keep = (from: number, to: number) => {
    for (let line = from; line < to; line++) {
      out.push(lines[line - 1]);
      outBreaks.push(breaks[line - 1] ?? eol);
    }
  };

  let next = 1;
  for (const { original: from, modified: to } of changes) {
    keep(next, from.startLineNumber);
    for (let line = to.startLineNumber; line < to.endLineNumberExclusive; line++) {
      out.push(modifiedLines[line - 1]);
      outBreaks.push(eol);
    }
    next = from.endLineNumberExclusive;
  }
  keep(next, lines.length + 1);

  return out.map((line, i) => (i < out.length - 1 ? line + outBreaks[i] : line)).join("");
}

export function selectedLineRange(selection: {
  startLineNumber: number;
  endLineNumber: number;
  endColumn: number;
}): LineRange {
  const end =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return lineRange(selection.startLineNumber, end + 1);
}
