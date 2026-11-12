/**
 * The ways the agent list lays out a workspace's conversations: a list by
 * where each stands for the user, or one group per worktree (the workspace
 * and its tasks).
 */

export const AGENT_LIST_VIEWS = ["status", "task"] as const;
export type AgentListView = (typeof AGENT_LIST_VIEWS)[number];

export const DEFAULT_AGENT_LIST_VIEW: AgentListView = "status";

/** The views earlier versions had, by the one now showing the same. */
const RETIRED_VIEWS: Readonly<Record<string, AgentListView>> = {
  tree: "task",
  lineage: "task",
  board: "status",
  timeline: "status",
};

/** A stored view, or undefined when it is none this version has. */
export function asAgentListView(value: string | undefined): AgentListView | undefined {
  if (value === undefined) return undefined;
  return AGENT_LIST_VIEWS.find((view) => view === value) ?? RETIRED_VIEWS[value];
}
