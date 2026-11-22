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
  readonly roots: readonly SessionTreeNode[];
  readonly moved: readonly { key: string; title: string; count: number }[];
}

export function workspaceTrees(
  families: readonly SessionFamily[],
  roots: readonly SessionTreeNode[],
  order: AgentOrder,
  searching: boolean,
): readonly { family: SessionFamily; worktrees: readonly SidebarWorktree[] }[] {
  const byWorkspace = new Map<string, SessionTreeNode[]>();
  const moved = new Map<string, SidebarWorktree["moved"][number][]>();
  for (const root of roots) {
    const { workspaceId, title, key } = root.session;
    const group = byWorkspace.get(workspaceId) ?? [];
    group.push(root);
    byWorkspace.set(workspaceId, group);

    const counts = new Map<string, number>();
    for (const child of treeSessions(root.children)) {
      if (child.workspaceId === workspaceId) continue;
      counts.set(child.workspaceId, (counts.get(child.workspaceId) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      const notes = moved.get(id) ?? [];
      notes.push({ key, title, count });
      moved.set(id, notes);
    }
  }
  return families.flatMap((family) => {
    const worktrees = family.worktrees.flatMap((worktree) => {
      const id = worktree.workspace.id;
      const rows = byWorkspace.get(id) ?? [];
      const notes = worktree.isRoot ? [] : (moved.get(id) ?? []);
      if (!rows.length && !notes.length && (!worktree.isRoot || searching)) return [];
      const ordered = orderSessions(
        rows.map((node) => ({ key: node.session.key, node })),
        order[id],
      );
      return [{ worktree, roots: ordered.map(({ node }) => node), moved: notes }];
    });
    return worktrees.length ? [{ family, worktrees }] : [];
  });
}
