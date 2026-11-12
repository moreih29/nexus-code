// Agent list — what the list marks: the conversation whose tab is shown,
// or an agent a conversation runs, whose card is open beside the list.

export type AgentListSelection =
  | { readonly kind: "session"; readonly key: string }
  | { readonly kind: "agent"; readonly key: string; readonly agentId: string };

/** Whether `selection` names the session `key`, or one of its agents. */
export function isSessionSelected(selection: AgentListSelection | null, key: string): boolean {
  return selection?.key === key;
}
