import { useCallback, useSyncExternalStore } from "react";
import { createListenerBus } from "../../../../shared/util/listener-bus";

type WorkspaceId = string;
type LeafId = string;

export const AGENT_VIEW_SLOTS = "agent-view";

const slots = new Map<string, HTMLElement>();
const bus = createListenerBus();

export const slotRegistry: {
  set(workspaceId: WorkspaceId, leafId: LeafId, el: HTMLElement | null): void;
  get(workspaceId: WorkspaceId, leafId: LeafId): HTMLElement | null;
  subscribe(listener: () => void): () => void;
} = {
  set(workspaceId, leafId, el) {
    const key = `${workspaceId}:${leafId}`;
    if (el === null) {
      if (slots.has(key)) {
        slots.delete(key);
        bus.notify();
      }
      return;
    }
    if (slots.get(key) === el) {
      return;
    }
    slots.set(key, el);
    bus.notify();
  },

  get(workspaceId, leafId) {
    return slots.get(`${workspaceId}:${leafId}`) ?? null;
  },

  subscribe(listener) {
    return bus.subscribe(listener);
  },
};

const getServerSnapshot = (): null => null;

export function useSlotElement(
  workspaceId: WorkspaceId,
  leafId: LeafId | null,
): HTMLElement | null {
  const getSnapshot = useCallback(
    () => (leafId === null ? null : slotRegistry.get(workspaceId, leafId)),
    [workspaceId, leafId],
  );
  return useSyncExternalStore(slotRegistry.subscribe, getSnapshot, getServerSnapshot);
}
