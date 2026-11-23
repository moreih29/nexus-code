import type { DirtyChange, DirtyChangeType } from "./types";

export interface LineRangeLike {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
  readonly isEmpty: boolean;
}

export interface LineRangeMappingLike {
  readonly original: LineRangeLike;
  readonly modified: LineRangeLike;
}

function classify(originalEmpty: boolean, modifiedEmpty: boolean): DirtyChangeType {
  if (originalEmpty) return "add";
  if (modifiedEmpty) return "delete";
  return "modify";
}

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
