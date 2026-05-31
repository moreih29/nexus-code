/**
 * Pure transform from monaco's diff mappings to our {@link DirtyChange} model.
 *
 * Kept in its own module — free of the monaco internal-diff import — so it can
 * be unit-tested under runners whose bare-specifier resolver cannot load
 * monaco's `esm/` subpaths.
 */

import type { DirtyChange, DirtyChangeType } from "./types";

/** The slice of monaco's `LineRange` we read. */
export interface LineRangeLike {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
  readonly isEmpty: boolean;
}

/** The slice of monaco's `DetailedLineRangeMapping` we read. */
export interface LineRangeMappingLike {
  readonly original: LineRangeLike;
  readonly modified: LineRangeLike;
}

function classify(originalEmpty: boolean, modifiedEmpty: boolean): DirtyChangeType {
  if (originalEmpty) return "add";
  if (modifiedEmpty) return "delete";
  return "modify";
}

/**
 * Maps monaco diff mappings to {@link DirtyChange}s.
 *
 * `endLineNumberExclusive` is one past the last line; we convert to an
 * inclusive end. Empty ranges (insertion / deletion anchors) collapse to a 0
 * end so downstream code can detect "no lines on this side".
 */
export function mapChangesToDirty(changes: ReadonlyArray<LineRangeMappingLike>): DirtyChange[] {
  return changes.map(
    ({ original, modified }): DirtyChange => ({
      type: classify(original.isEmpty, modified.isEmpty),
      originalStartLineNumber: original.startLineNumber,
      originalEndLineNumber: original.isEmpty ? 0 : original.endLineNumberExclusive - 1,
      modifiedStartLineNumber: modified.startLineNumber,
      modifiedEndLineNumber: modified.isEmpty ? 0 : modified.endLineNumberExclusive - 1,
    }),
  );
}
