import { useSyncExternalStore } from "react";
import { computeActiveContext } from "../../state/claude-active-context-sync";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useLayoutStore } from "../../state/stores/layout/store";
import { sessionKey } from "./model";

export function viewingKey(): string | null {
  if (!useAppFocusStore.getState().focused) return null;
  const { workspaceId, tabId } = computeActiveContext();
  return workspaceId !== null && tabId !== null ? sessionKey(workspaceId, tabId) : null;
}

function subscribeViewing(onChange: () => void): () => void {
  const stops = [
    useAppFocusStore.subscribe(onChange),
    useActiveStore.subscribe(onChange),
    useLayoutStore.subscribe(onChange),
    useAgentViewStore.subscribe(onChange),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

export function useViewingKey(): string | null {
  return useSyncExternalStore(subscribeViewing, viewingKey, viewingKey);
}
