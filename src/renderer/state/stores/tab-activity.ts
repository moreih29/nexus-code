/**
 * Every live terminal's output activity, which tells what Codex and other
 * agents are doing, as main last reported it. Read every few seconds for the
 * tab bar, the sidebar and the inbox; the agent list reads it faster on its
 * own while it is shown.
 */

import { create } from "zustand";
import { BUSY_WINDOW_MS, type TabActivity } from "../../../shared/sessions/agent-state";

interface TabActivityStore {
  /** Keyed by `${workspaceId}:${tabId}`. */
  activity: ReadonlyMap<string, TabActivity>;
}

export const useTabActivityStore = create<TabActivityStore>(() => ({
  activity: new Map(),
}));

// Estimated status also depends on how long ago a terminal printed. Only
// notify status consumers when the clock crosses a busy window boundary.
let readAt = Date.now();
const clockListeners = new Set<() => void>();

export function tabActivityReadAt(): number {
  return readAt;
}

export function subscribeTabActivity(listener: () => void): () => void {
  const stop = useTabActivityStore.subscribe(listener);
  clockListeners.add(listener);
  return () => {
    stop();
    clockListeners.delete(listener);
  };
}

export function publishTabActivity(activity: ReadonlyMap<string, TabActivity>, at: number): void {
  const previousReadAt = readAt;
  readAt = at;
  if (activity !== useTabActivityStore.getState().activity) {
    useTabActivityStore.setState({ activity });
    return;
  }
  for (const { lastOutputAt } of activity.values()) {
    const busyUntil = lastOutputAt + BUSY_WINDOW_MS;
    const wasBusy = previousReadAt < busyUntil;
    const isBusy = at < busyUntil;
    if (wasBusy === isBusy) continue;
    for (const listener of clockListeners) listener();
    break;
  }
}
