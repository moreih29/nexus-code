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
