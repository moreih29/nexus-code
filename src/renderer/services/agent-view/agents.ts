/**
 * The agents of every workspace, as the agent view lists them: by the
 * workspace they run in, a workspace's tasks under it, pinned workspaces
 * first as the sidebar orders them. Pure: built from the same records as the
 * agent list and the inbox.
 */

import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { tasksOf, visibleWorkspaces } from "../../state/stores/workspaces";
import {
  type AgentSession,
  type SessionFamily,
  type SessionsInput,
  sameFamily,
  sessionsOf,
} from "../agent-sessions/model";
import { groupOf } from "../agent-sessions/rows";

export interface AgentsInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
}

export interface AgentEntry {
  readonly workspace: WorkspaceMeta;
  /** The workspace it is listed under: its own, or the one its task belongs to. */
  readonly root: WorkspaceMeta;
  readonly session: AgentSession;
}

export interface Agents {
  /** Each workspace with its tasks and their agents, in the sidebar's order. */
  readonly families: readonly SessionFamily[];
  readonly byKey: ReadonlyMap<string, AgentEntry>;
}

export function buildAgents(input: AgentsInput): Agents {
  const roots = visibleWorkspaces(input.workspaces);
  const ordered = [...roots.filter((w) => w.pinned), ...roots.filter((w) => !w.pinned)];
  const byKey = new Map<string, AgentEntry>();
  const families = ordered.map((root) => {
    const worktrees = [root, ...tasksOf(input.workspaces, root.id)].map((workspace) => {
      const sessions = sessionsOf(input, workspace);
      for (const session of sessions) byKey.set(session.key, { workspace, root, session });
      return {
        workspace,
        isRoot: workspace.id === root.id,
        branch: workspace.task?.branch,
        sessions,
      };
    });
    return { root, worktrees };
  });
  return { families, byKey };
}

/** Whether two builds list the same, to keep the one already shown. */
export function sameAgents(a: Agents, b: Agents): boolean {
  return (
    a.families.length === b.families.length &&
    a.families.every((family, i) => sameFamily(family, b.families[i] ?? null))
  );
}

/** The filters of the list, in its order: every agent, then each group the agent list has. */
export const AGENT_FILTERS = ["all", "running", "attention", "done", "idle"] as const;
export type AgentFilter = (typeof AGENT_FILTERS)[number];

/**
 * Whether `filter` lists `session`: in the group the agent list puts it in,
 * where one that ended is in none of these.
 */
export function passesFilter(session: AgentSession, filter: AgentFilter): boolean {
  return filter === "all" || groupOf(session) === filter;
}

/** How many agents each filter lists. */
export function agentCounts(agents: Agents): Record<AgentFilter, number> {
  const counts: Record<AgentFilter, number> = {
    all: agents.byKey.size,
    running: 0,
    attention: 0,
    done: 0,
    idle: 0,
  };
  for (const { session } of agents.byKey.values()) {
    const group = groupOf(session);
    if (group !== "ended") counts[group]++;
  }
  return counts;
}

/** The palette's colors, one per workspace and its tasks, so its panels read as its own. */
const WORKSPACE_COLORS = 8;

/** The color of a workspace's agents: one of the theme's lane colors, by its id. */
export function workspaceColor(rootId: string): string {
  let hash = 0;
  for (let i = 0; i < rootId.length; i++) hash = (hash * 31 + rootId.charCodeAt(i)) | 0;
  return `var(--color-git-lane-${Math.abs(hash) % WORKSPACE_COLORS})`;
}
