import type { SessionFamily, WorktreeEntry } from "../agent-sessions/model";
import type { RowGroup } from "../agent-sessions/rows";
import { type SessionTreeNode, treeSessions } from "../agent-sessions/session-tree";
import { type AgentOrder, type DropEdge, moveKey, orderSessions, reorderSubset } from "./order";

export function statusTrees(
  roots: readonly SessionTreeNode[],
): Record<RowGroup, SessionTreeNode[]> {
  const groups: Record<RowGroup, SessionTreeNode[]> = {
    attention: [],
    running: [],
    done: [],
    idle: [],
  };
  for (const node of roots) groups[node.group].push(node);
  return groups;
}

/** Reorder roots in their existing slots while leaving hidden tabs and children in place. */
export function moveSessionRoot(
  keys: readonly string[],
  roots: readonly string[],
  moved: string,
  target: string,
  edge: DropEdge,
): readonly string[] {
  const movable = new Set(roots);
  if (moved === target || !movable.has(moved) || !movable.has(target)) return keys;
  const next = moveKey(
    keys.filter((key) => movable.has(key)),
    moved,
    target,
    edge,
  );
  return reorderSubset(keys, next, (key) => key);
}

export interface SidebarWorktree {
  readonly worktree: WorktreeEntry;
  /** Its own conversations: those it holds whose parent, if any, is not listed. */
  readonly roots: readonly SessionTreeNode[];
  /** Conversations it holds that are listed under a parent elsewhere. */
  readonly hosted: number;
}

/**
 * Each workspace's worktrees with their own conversations. A child
 * conversation is listed under its parent wherever it runs, so a worktree
 * holding only children is left out unless `includeEmpty` keeps it.
 */
export function workspaceTrees(
  families: readonly SessionFamily[],
  roots: readonly SessionTreeNode[],
  order: AgentOrder,
  searching: boolean,
  includeEmpty: (worktree: WorktreeEntry) => boolean = (worktree) => worktree.isRoot && !searching,
): readonly { family: SessionFamily; worktrees: readonly SidebarWorktree[] }[] {
  const byWorkspace = new Map<string, SessionTreeNode[]>();
  const hosted = new Map<string, number>();
  for (const root of roots) {
    const { workspaceId } = root.session;
    const group = byWorkspace.get(workspaceId) ?? [];
    group.push(root);
    byWorkspace.set(workspaceId, group);
    for (const child of treeSessions(root.children)) {
      if (child.workspaceId !== workspaceId)
        hosted.set(child.workspaceId, (hosted.get(child.workspaceId) ?? 0) + 1);
    }
  }
  return families.flatMap((family) => {
    const worktrees = family.worktrees.flatMap((worktree) => {
      const id = worktree.workspace.id;
      const rows = byWorkspace.get(id) ?? [];
      if (!rows.length && !includeEmpty(worktree)) return [];
      const ordered = orderSessions(
        rows.map((node) => ({ key: node.session.key, node })),
        order[id],
      );
      return [{ worktree, roots: ordered.map(({ node }) => node), hosted: hosted.get(id) ?? 0 }];
    });
    return worktrees.length ? [{ family, worktrees }] : [];
  });
}
