/**
 * Pure line-change arithmetic behind staging part of a file — VSCode's
 * "Stage Change" / "Stage Selected Ranges" and their unstage counterparts.
 *
 * Staging a change writes a new index version: the index text with that
 * change taken from the working text. Unstaging writes the index text with
 * the change put back to HEAD's. Both are {@link applyLineChanges} over the
 * changes the caller picked with {@link selectChanges}.
 *
 * Kept free of the monaco runtime so it can be unit-tested.
 */

import type { DirtyChange } from "../dirty-diff/types";

/** 1-based lines `[startLineNumber, endLineNumberExclusive)`; empty at an insertion point. */
export interface LineRange {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
}

/** Lines of the original text that became lines of the modified text. */
export interface LineChange {
  readonly original: LineRange;
  readonly modified: LineRange;
}

/** The slice of monaco's `ILineChange` (from `IDiffEditor.getLineChanges()`) we read. */
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

/** A dirty-diff change, whose empty side is an insertion point before its start line. */
export function lineChangeOfDirty(change: DirtyChange): LineChange {
  const side = (start: number, end: number) => lineRange(start, end === 0 ? start : end + 1);
  return {
    original: side(change.originalStartLineNumber, change.originalEndLineNumber),
    modified: side(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
  };
}

/** A diff editor change, whose empty side sits after its start line. */
export function lineChangeOfMonaco(change: MonacoLineChangeLike): LineChange {
  const side = (start: number, end: number) =>
    end === 0 ? lineRange(start + 1, start + 1) : lineRange(start, end + 1);
  return {
    original: side(change.originalStartLineNumber, change.originalEndLineNumber),
    modified: side(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
  };
}

/** The change with its sides swapped: the way back from modified to original. */
export function invertLineChange(change: LineChange): LineChange {
  return { original: change.modified, modified: change.original };
}

/**
 * The part of `change` whose modified lines fall in `range`, or null.
 *
 * A deletion counts when `range` reaches the line on either side of its gap.
 * A change cut short keeps its original lines line by line when both sides
 * have as many; otherwise all of them, replaced by just the chosen lines —
 * VSCode's heuristic.
 */
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

/**
 * The parts of `changes` (ordered, as a diff yields them) that `ranges` of
 * modified lines pick. Each change takes its part from the first range that
 * reaches it, so the results never overlap.
 */
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

/** `text` split into lines as monaco splits a model, with the break after each. */
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

/**
 * `original` with each of `changes` (ordered, non-overlapping) replaced by
 * the modified lines it maps to.
 *
 * Untouched lines keep their own line breaks; lines taken from the modified
 * text get the original's first line break, or `fallbackEol` for an original
 * of one line. A missing final newline stays missing unless a change moves it.
 */
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

/**
 * The modified lines an editor selection covers. A selection that ends at the
 * start of a line leaves that line out, as VSCode's does.
 */
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
