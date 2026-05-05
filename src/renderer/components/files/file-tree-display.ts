/**
 * Pure helper: insert a "pending create" sentinel row into the flat
 * file-tree list at the right position.
 *
 * VSCode parity: the input row appears at the boundary between the
 * parent's direct dir-children and its file-children — i.e. just after
 * the last folder (and that folder's whole subtree) and just before the
 * first file. When the parent has only dirs, the row lands at the end
 * of the parent's subtree; when it has only files, it lands directly
 * after the parent row.
 *
 * If the parent isn't in `flat` (e.g. collapsed or not yet loaded),
 * the sentinel is dropped — the caller should expand the parent before
 * calling startCreate.
 *
 * Lives outside file-tree.tsx so the position-calculation can be unit
 * tested without React.
 */

import type { FlatItem } from "@/state/stores/files";

export type EntryKind = "file" | "folder";

export interface PendingCreate {
  parentAbsPath: string;
  kind: EntryKind;
}

export interface PendingFlatItem {
  kind: "pending";
  parentAbsPath: string;
  entryKind: EntryKind;
  depth: number;
}

export type DisplayItem = ({ kind: "real" } & FlatItem) | PendingFlatItem;

export function getDisplayFlat(flat: FlatItem[], pending: PendingCreate | null): DisplayItem[] {
  const real: DisplayItem[] = flat.map((item) => ({ kind: "real", ...item }));
  if (!pending) return real;

  const parentIdx = flat.findIndex((it) => it.absPath === pending.parentAbsPath);
  if (parentIdx === -1) return real;

  const parent = flat[parentIdx];
  const childDepth = parent.depth + 1;

  // Walk forward from the parent row, stopping either when we leave the
  // parent's subtree (depth <= parent.depth) or when we hit the first
  // direct file-child. Anything in between (dirs + their subtrees) sits
  // before the sentinel.
  let insertIdx = flat.length;
  for (let i = parentIdx + 1; i < flat.length; i++) {
    const item = flat[i];
    if (item.depth <= parent.depth) {
      insertIdx = i;
      break;
    }
    if (item.depth === childDepth && item.node.type !== "dir") {
      insertIdx = i;
      break;
    }
  }

  const sentinel: PendingFlatItem = {
    kind: "pending",
    parentAbsPath: pending.parentAbsPath,
    entryKind: pending.kind,
    depth: childDepth,
  };

  return [...real.slice(0, insertIdx), sentinel, ...real.slice(insertIdx)];
}
