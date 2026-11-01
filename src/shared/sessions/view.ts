/**
 * The ways the sessions tab lays out a workspace's agent sessions: a tree of
 * its worktrees beside the chosen session's detail, a board of columns by
 * state, the lineage of which session made which task, or a timeline of
 * what each did.
 */

export const SESSIONS_VIEWS = ["tree", "board", "lineage", "timeline"] as const;
export type SessionsView = (typeof SESSIONS_VIEWS)[number];

export const DEFAULT_SESSIONS_VIEW: SessionsView = "tree";

/** A stored view, or undefined when it is none this version has. */
export function asSessionsView(value: string | undefined): SessionsView | undefined {
  return SESSIONS_VIEWS.find((view) => view === value);
}
