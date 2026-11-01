// Sessions tab — what the detail panel shows: a session, an agent a session
// runs, or a worktree (which may have none).

import { allSessions, firstSession, type SessionFamily } from "../../services/sessions/model";

export type SessionsSelection =
  | { readonly kind: "session"; readonly key: string }
  | { readonly kind: "agent"; readonly key: string; readonly agentId: string }
  | { readonly kind: "worktree"; readonly workspaceId: string };

/**
 * The selection if it still names something in the family, else the
 * session to show first, else the workspace itself. An agent whose record
 * is gone gives way to its session.
 */
export function resolveSelection(
  family: SessionFamily,
  selection: SessionsSelection | null,
  hasAgent: (key: string, agentId: string) => boolean = () => true,
): SessionsSelection {
  if (selection?.kind === "session" || selection?.kind === "agent") {
    if (allSessions(family).some((s) => s.key === selection.key)) {
      return selection.kind === "agent" && !hasAgent(selection.key, selection.agentId)
        ? { kind: "session", key: selection.key }
        : selection;
    }
  } else if (selection?.kind === "worktree") {
    if (family.worktrees.some((w) => w.workspace.id === selection.workspaceId)) return selection;
  }
  const first = firstSession(family);
  return first
    ? { kind: "session", key: first.key }
    : { kind: "worktree", workspaceId: family.root.id };
}

/** Whether `selection` names the session `key`, or one of its agents. */
export function isSessionSelected(selection: SessionsSelection | null, key: string): boolean {
  return selection?.kind === "session" && selection.key === key;
}

/** Whether `selection` names the agent `agentId` of the session `key`. */
export function isAgentSelected(
  selection: SessionsSelection | null,
  key: string,
  agentId: string,
): boolean {
  return selection?.kind === "agent" && selection.key === key && selection.agentId === agentId;
}
