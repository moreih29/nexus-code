import type { WorkspaceMeta } from "../../../shared/types/workspace";
import {
  WORKSPACE_COLORS,
  type WorkspaceColor,
  workspaceColorToken,
} from "../../../shared/types/workspace-color";
import { tasksOf, visibleWorkspaces } from "../../state/stores/workspaces";
import {
  type AgentSession,
  type SessionFamily,
  type SessionsInput,
  sameFamily,
  sameSession,
  sessionsOf,
} from "../agent-sessions/model";

export interface AgentsInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
}

export interface AgentEntry {
  readonly workspace: WorkspaceMeta;
  readonly root: WorkspaceMeta;
  readonly session: AgentSession;
}

export interface Agents {
  readonly families: readonly SessionFamily[];
  readonly byKey: ReadonlyMap<string, AgentEntry>;
}

export function buildAgents(input: AgentsInput, previous?: Agents): Agents {
  const roots = visibleWorkspaces(input.workspaces);
  const ordered = [...roots.filter((w) => w.pinned), ...roots.filter((w) => !w.pinned)];
  const byKey = new Map<string, AgentEntry>();
  const families = ordered.map((root) => {
    const worktrees = [root, ...tasksOf(input.workspaces, root.id)].map((workspace) => {
      const sessions = sessionsOf(input, workspace).map((session) => {
        const prior = previous?.byKey.get(session.key);
        const kept = prior && sameSession(prior.session, session) ? prior.session : session;
        const entry =
          prior?.workspace === workspace && prior.root === root && prior.session === kept
            ? prior
            : { workspace, root, session: kept };
        byKey.set(session.key, entry);
        return kept;
      });
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

export function sameAgents(a: Agents, b: Agents): boolean {
  return (
    a.families.length === b.families.length &&
    a.families.every((family, i) => sameFamily(family, b.families[i] ?? null))
  );
}

const WORKSPACE_PALETTE_SIZE = WORKSPACE_COLORS.length;

export function workspaceColor(rootId: string, color: WorkspaceColor = "auto"): string {
  const chosen = workspaceColorToken(color);
  if (chosen !== null) return chosen;
  let hash = 0;
  for (let i = 0; i < rootId.length; i++) hash = (hash * 31 + rootId.charCodeAt(i)) | 0;
  return `var(--color-git-lane-${Math.abs(hash) % WORKSPACE_PALETTE_SIZE})`;
}
