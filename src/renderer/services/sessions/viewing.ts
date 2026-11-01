/**
 * The terminal in front of the user: the active one, while the app window
 * has focus, as main counts it for Claude's notifications.
 */

import { useSyncExternalStore } from "react";
import { computeActiveContext } from "../../state/claude-active-context-sync";
import { useActiveStore } from "../../state/stores/active";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useLayoutStore } from "../../state/stores/layout/store";
import { sessionKey } from "./model";

/** The terminal in front of the user, by session key. */
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
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/** viewingKey, kept current. */
export function useViewingKey(): string | null {
  return useSyncExternalStore(subscribeViewing, viewingKey, viewingKey);
}
