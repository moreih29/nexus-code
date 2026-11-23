import type { WorkspaceMeta } from "./types/workspace";

type Ordered = Pick<WorkspaceMeta, "pinned" | "sortOrder" | "pinnedSortOrder">;

export function workspaceSortKey(meta: Ordered): [number, number] {
  return meta.pinned ? [0, meta.pinnedSortOrder ?? 0] : [1, meta.sortOrder ?? 0];
}

export function compareWorkspaceOrder(a: Ordered, b: Ordered): number {
  const [ag, ao] = workspaceSortKey(a);
  const [bg, bo] = workspaceSortKey(b);
  return ag !== bg ? ag - bg : ao - bo;
}
