import { create } from "zustand";
import { BUSY_WINDOW_MS, type TabActivity } from "../../../shared/sessions/agent-state";

interface TabActivityStore {
  activity: ReadonlyMap<string, TabActivity>;
}

export const useTabActivityStore = create<TabActivityStore>(() => ({
  activity: new Map(),
}));

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
