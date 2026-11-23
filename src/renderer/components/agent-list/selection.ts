export type AgentListSelection =
  | { readonly kind: "session"; readonly key: string }
  | { readonly kind: "agent"; readonly key: string; readonly agentId: string };

export function isSessionSelected(selection: AgentListSelection | null, key: string): boolean {
  return selection?.key === key;
}
