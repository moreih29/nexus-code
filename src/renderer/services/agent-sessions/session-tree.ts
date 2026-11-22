import type { AgentSession, SessionPhase } from "./model";
import { compareStatusTime, listed, matchesQuery, ROW_GROUPS } from "./rows";

const MAX_PARENT_STEPS = 8;
export const MAX_SESSION_INDENT = 2;

export type SessionCounts = Readonly<Record<SessionPhase, number>>;

export interface SessionTreeNode {
  readonly session: AgentSession;
  readonly children: readonly SessionTreeNode[];
  /** True depth, even when the sidebar indents the row by less. */
  readonly depth: number;
  readonly parentName?: string;
  readonly parentClosed?: true;
  readonly count: number;
  readonly counts: SessionCounts;
  /** The most urgent state in the subtree, and its time in that state. */
  readonly group: SessionPhase;
  readonly since: number | undefined;
}

export function familyFoldKey(session: AgentSession): string {
  return `family:${session.key}`;
}

/** Resolves the parents of listed sessions. Older layouts use their saved tab order. */
export function sessionTree(sessions: readonly AgentSession[]): readonly SessionTreeNode[] {
  const visible = sessions.filter(listed);
  const byTab = new Map(visible.map((session) => [session.tabId, session]));
  const children = new Map<string, AgentSession[]>();
  const roots: AgentSession[] = [];

  for (const session of visible) {
    let parentId: string | undefined;
    let current = session;
    const visited = new Set([session.tabId]);
    while (current.parent?.tabId && !current.parent.device) {
      const next = byTab.get(current.parent.tabId);
      // The highest tab still in the list is the root when its opener is gone.
      if (!next) break;
      if (visited.has(next.tabId) || visited.size > MAX_PARENT_STEPS) {
        parentId = undefined;
        break;
      }
      parentId ??= next.tabId;
      visited.add(next.tabId);
      current = next;
    }
    if (!parentId) {
      roots.push(session);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(session);
    children.set(parentId, siblings);
  }

  function branch(session: AgentSession, depth: number): SessionTreeNode {
    const siblings = children.get(session.tabId) ?? [];
    siblings.sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
    const branches = siblings.map((child) => branch(child, depth + 1));
    const counts = { attention: 0, running: 0, done: 0, idle: 0 };
    let group = session.phase;
    let since = session.since;
    let count = 0;
    for (const child of branches) {
      count += child.count + 1;
      for (const phase of ROW_GROUPS) counts[phase] += child.counts[phase];
      counts[child.session.phase]++;
      if (
        ROW_GROUPS.indexOf(child.group) < ROW_GROUPS.indexOf(group) ||
        (child.group === group && compareStatusTime(group, child.since, since) < 0)
      ) {
        group = child.group;
        since = child.since;
      }
    }
    const opener = session.parent;
    const parent = opener?.tabId && !opener.device ? byTab.get(opener.tabId) : undefined;
    const name = parent?.title || opener?.name || opener?.tabId?.slice(0, 8) || opener?.agent;
    return {
      session,
      children: branches,
      depth,
      ...(name ? { parentName: name } : {}),
      ...(opener && !opener.device && !parent && (opener.tabId || opener.name)
        ? { parentClosed: true }
        : {}),
      count,
      counts,
      group,
      since,
    };
  }
  return roots.map((root) => branch(root, 0));
}

/** Keeps a matching session and the rows needed to reach it. The family's state stays intact. */
export function searchSessionTree(
  roots: readonly SessionTreeNode[],
  query: string,
): readonly SessionTreeNode[] {
  if (!query.trim()) return roots;
  return roots.flatMap((node) => {
    const children = searchSessionTree(node.children, query);
    return children.length || matchesQuery(node.session, query) ? [{ ...node, children }] : [];
  });
}

/** The status view can disclose whole idle branches without hiding active descendants. */
export function sessionChildren(
  node: SessionTreeNode,
  { folded, groupIdle, showIdle }: { folded: boolean; groupIdle: boolean; showIdle: boolean },
): { rows: readonly SessionTreeNode[]; idle: number } {
  if (folded) return { rows: [], idle: 0 };
  if (!groupIdle) return { rows: node.children, idle: 0 };
  let idle = 0;
  for (const child of node.children) {
    if (child.group === "idle") idle += child.count + 1;
  }
  return {
    rows:
      idle && !showIdle ? node.children.filter((child) => child.group !== "idle") : node.children,
    idle,
  };
}

/** Sessions in their visible tree order, independent of disclosure controls. */
export function* treeSessions(roots: readonly SessionTreeNode[]): Iterable<AgentSession> {
  for (const node of roots) {
    yield node.session;
    yield* treeSessions(node.children);
  }
}
