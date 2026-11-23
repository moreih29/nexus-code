export const AGENT_LIST_VIEWS = ["status", "task"] as const;
export type AgentListView = (typeof AGENT_LIST_VIEWS)[number];

export const DEFAULT_AGENT_LIST_VIEW: AgentListView = "status";

const RETIRED_VIEWS: Readonly<Record<string, AgentListView>> = {
  tree: "task",
  lineage: "task",
  board: "status",
  timeline: "status",
};

export function asAgentListView(value: string | undefined): AgentListView | undefined {
  if (value === undefined) return undefined;
  return AGENT_LIST_VIEWS.find((view) => view === value) ?? RETIRED_VIEWS[value];
}
