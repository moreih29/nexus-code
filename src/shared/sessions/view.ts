/**
 * The ways the agents tab lays out a workspace's conversations: a list by
 * where each stands for the user, or one group per worktree (the workspace
 * and its tasks).
 */

export const SESSIONS_VIEWS = ["status", "task"] as const;
export type SessionsView = (typeof SESSIONS_VIEWS)[number];

export const DEFAULT_SESSIONS_VIEW: SessionsView = "status";

/** The views earlier versions had, by the one now showing the same. */
const RETIRED_VIEWS: Readonly<Record<string, SessionsView>> = {
  tree: "task",
  lineage: "task",
  board: "status",
  timeline: "status",
};

/** A stored view, or undefined when it is none this version has. */
export function asSessionsView(value: string | undefined): SessionsView | undefined {
  if (value === undefined) return undefined;
  return SESSIONS_VIEWS.find((view) => view === value) ?? RETIRED_VIEWS[value];
}
