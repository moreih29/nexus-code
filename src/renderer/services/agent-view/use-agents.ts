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
import { sessionsInputNow } from "../agent-sessions/use-inbox";
import { useChatStore } from "../chat/store";
import { type Agents, buildAgents, sameAgents } from "./agents";

/** The agents, kept current while `enabled`; the last read otherwise. */
export function useAgents(enabled = true): Agents {
  const [agents, setAgents] = useState(() =>
    buildAgents(sessionsInputNow(useTabActivityStore.getState().activity)),
  );
  useEffect(() => {
    if (!enabled) return;
    const update = (): void => {
      const input = sessionsInputNow(useTabActivityStore.getState().activity);
      setAgents((prev) => {
        const next = buildAgents(input, prev);
        return sameAgents(prev, next) ? prev : next;
      });
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
