import { create } from "zustand";
import type { AgentRun } from "../../../shared/claude/activity";

export type AgentRef = Pick<AgentRun, "id" | "kind">;

interface AgentRevealStore {
  asked: Readonly<Record<string, AgentRef>>;
}

export const useAgentRevealStore = create<AgentRevealStore>(() => ({ asked: {} }));

export function askToShowAgent(tabId: string, agent: AgentRef): void {
  useAgentRevealStore.setState((state) => ({
    asked: { ...state.asked, [tabId]: { id: agent.id, kind: agent.kind } },
  }));
}

export function dropAgentAsk(tabId: string): void {
  const { asked } = useAgentRevealStore.getState();
  if (!(tabId in asked)) return;
  const rest = { ...asked };
  delete rest[tabId];
  useAgentRevealStore.setState({ asked: rest });
}
