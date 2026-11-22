import { useAgentViewStore } from "../../state/stores/agent-view";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { type AgentSession, sessionsOf } from "../agent-sessions/model";
import { sessionsInputNow } from "../agent-sessions/use-inbox";
import { orderSessions, reorderSubset } from "./order";

/** The workspace's agents in sidebar order, including agents hidden by the list. */
export function orderedSidebarSessions(workspaceId: string): readonly AgentSession[] | undefined {
  const input = sessionsInputNow(useTabActivityStore.getState().activity);
  const workspace = input.workspaces.find(({ id }) => id === workspaceId);
  if (!workspace) return undefined;
  return orderSessions(
    sessionsOf(input, workspace),
    useAgentViewStore.getState().order[workspaceId],
  );
}

/** Applies a remote order to the slots held by its tabs. */
export function reorderSidebarSessions(workspaceId: string, tabIds: readonly string[]): boolean {
  const sessions = orderedSidebarSessions(workspaceId);
  if (!sessions) return false;
  const next = reorderSubset(sessions, tabIds, (session) => session.tabId);
  if (next !== sessions) {
    useAgentViewStore.getState().setOrder(
      workspaceId,
      next.map((session) => session.key),
    );
  }
  return true;
}
