/**
 * The agent a Claude or Codex tab is asked to show in its pane, from the
 * agent list: a subagent or a run, as the app's hooks tell it. The ask
 * waits, by the tab's id, until the tab shows that agent or the user picks
 * another, since the tab may not have its agents yet when it opens.
 */

import { create } from "zustand";
import type { AgentRun } from "../../../shared/claude/activity";

export type AgentRef = Pick<AgentRun, "id" | "kind">;

interface AgentRevealStore {
  /** By tab id. */
  asked: Readonly<Record<string, AgentRef>>;
}

export const useAgentRevealStore = create<AgentRevealStore>(() => ({ asked: {} }));

/** Asks the tab to show the agent in its pane, once it has it. */
export function askToShowAgent(tabId: string, agent: AgentRef): void {
  useAgentRevealStore.setState((state) => ({
    asked: { ...state.asked, [tabId]: { id: agent.id, kind: agent.kind } },
  }));
}

/** Drops the tab's ask, as shown or overruled. */
export function dropAgentAsk(tabId: string): void {
  const { asked } = useAgentRevealStore.getState();
  if (!(tabId in asked)) return;
  const rest = { ...asked };
  delete rest[tabId];
  useAgentRevealStore.setState({ asked: rest });
}
