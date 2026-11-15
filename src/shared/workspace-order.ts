/**
 * The order of the workspaces in the sidebar, which another device's list
 * follows too: those pinned first, each group by its own order (ascending);
 * a tie keeps the order they came in.
 */

import type { WorkspaceMeta } from "./types/workspace";

type Ordered = Pick<WorkspaceMeta, "pinned" | "sortOrder" | "pinnedSortOrder">;

/** Its group (pinned 0, the rest 1) and its order within it. */
export function workspaceSortKey(meta: Ordered): [number, number] {
  return meta.pinned ? [0, meta.pinnedSortOrder ?? 0] : [1, meta.sortOrder ?? 0];
}

export function compareWorkspaceOrder(a: Ordered, b: Ordered): number {
  const [ag, ao] = workspaceSortKey(a);
  const [bg, bo] = workspaceSortKey(b);
  return ag !== bg ? ag - bg : ao - bo;
}
