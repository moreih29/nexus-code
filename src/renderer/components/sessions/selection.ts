// Sessions tab — what the detail panel shows: a session, or a worktree
// (which may have none).

import { allSessions, firstSession, type SessionFamily } from "../../services/sessions/model";

export type SessionsSelection =
  | { readonly kind: "session"; readonly key: string }
  | { readonly kind: "worktree"; readonly workspaceId: string };

/**
 * The selection if it still names something in the family, else the
 * session to show first, else the workspace itself.
 */
export function resolveSelection(
  family: SessionFamily,
  selection: SessionsSelection | null,
): SessionsSelection {
  if (selection?.kind === "session") {
    if (allSessions(family).some((s) => s.key === selection.key)) return selection;
  } else if (selection?.kind === "worktree") {
    if (family.worktrees.some((w) => w.workspace.id === selection.workspaceId)) return selection;
  }
  const first = firstSession(family);
  return first
    ? { kind: "session", key: first.key }
    : { kind: "worktree", workspaceId: family.root.id };
}
