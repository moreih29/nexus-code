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
 * Workspace-root parent is a special case: `flat` excludes the root row
 * (it's hoisted into <WorkspaceRootHeader>), so a `parentAbsPath` equal
 * to `rootAbsPath` would not be found by a naive lookup. Pass the root
 * path explicitly so we can treat it as a synthetic depth-0 anchor at
 * index -1 and scan its direct (depth-1) children for the dir/file
 * boundary just like any other parent.
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

export interface PendingRename {
  absPath: string;
}

export interface PendingFlatItem {
  kind: "pending";
  parentAbsPath: string;
  entryKind: EntryKind;
  depth: number;
}

export interface RenameFlatItem {
  kind: "rename";
  absPath: string;
  entryKind: EntryKind;
  depth: number;
  initialName: string;
}

export type DisplayItem = ({ kind: "real" } & FlatItem) | PendingFlatItem | RenameFlatItem;

export function getDisplayFlat(
  flat: FlatItem[],
  pending: PendingCreate | null,
  pendingRename: PendingRename | null = null,
  rootAbsPath?: string,
): DisplayItem[] {
  const real: DisplayItem[] = flat.map((item) => {
    if (pendingRename?.absPath === item.absPath) {
      return {
        kind: "rename",
        absPath: item.absPath,
        entryKind: item.node.type === "dir" ? "folder" : "file",
        depth: item.depth,
        initialName: item.node.name,
      };
    }
    return { kind: "real", ...item };
  });
  if (!pending) return real;

  // Workspace-root case: root isn't in `flat` (sliced off in index.tsx
  // because the header renders it separately), so treat it as a synthetic
  // depth-0 anchor at index -1. Scan starts from i=0 and the boundary
  // logic below collapses cleanly — parentDepth=0 means the "leave the
  // subtree" guard never fires (no row in `flat` has depth ≤ 0).
  let parentIdx: number;
  let parentDepth: number;
  if (rootAbsPath !== undefined && pending.parentAbsPath === rootAbsPath) {
    parentIdx = -1;
    parentDepth = 0;
  } else {
    parentIdx = flat.findIndex((it) => it.absPath === pending.parentAbsPath);
    if (parentIdx === -1) return real;
    parentDepth = flat[parentIdx].depth;
  }
  const childDepth = parentDepth + 1;

  // Walk forward from the parent row, stopping either when we leave the
  // parent's subtree (depth <= parent.depth) or when we hit the first
  // direct file-child. Anything in between (dirs + their subtrees) sits
  // before the sentinel.
  let insertIdx = flat.length;
  for (let i = parentIdx + 1; i < flat.length; i++) {
    const item = flat[i];
    if (item.depth <= parentDepth) {
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
