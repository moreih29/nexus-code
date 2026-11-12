/**
 * The agents of every workspace, kept current while the agent view is up:
 * rebuilt as the stores change and as the terminals' activity is read. A
 * rebuild that lists the same keeps what is shown.
 */

import { useEffect, useState } from "react";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { viewingKey } from "../agent-sessions/viewing";
import { useChatStore } from "../chat/store";
import { type Agents, buildAgents, sameAgents } from "./agents";

function agentsNow(): Agents {
  return buildAgents({
    workspaces: useWorkspacesStore.getState().workspaces,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity: useTabActivityStore.getState().activity,
    now: Date.now(),
    seenByWorkspace: useSessionSeenStore.getState().byWorkspace,
    chats: useChatStore.getState().tabs,
    viewing: viewingKey(),
  });
}

/** The agents, kept current while `enabled`; the last read otherwise. */
export function useAgents(enabled = true): Agents {
  const [agents, setAgents] = useState(agentsNow);
  useEffect(() => {
    if (!enabled) return;
    const update = (): void => {
      const next = agentsNow();
      setAgents((prev) => (sameAgents(prev, next) ? prev : next));
    };
    const stops = [
      useWorkspacesStore.subscribe(update),
      useTabsStore.subscribe(update),
      useClaudeStatusStore.subscribe(update),
      useSessionSeenStore.subscribe(update),
      useChatStore.subscribe(update),
      useTabActivityStore.subscribe(update),
      useAgentViewStore.subscribe(update),
      useAppFocusStore.subscribe(update),
    ];
    update();
    return () => {
      for (const stop of stops) stop();
    };
  }, [enabled]);
  return agents;
}
