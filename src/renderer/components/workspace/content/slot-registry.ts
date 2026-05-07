// ---------------------------------------------------------------------------
// Slot registry for createPortal-based content rendering.
// Maps `${workspaceId}:${leafId}` keys to DOM container elements so that
// ContentPool can portal content into the correct leaf slot.
// ---------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from "react";
import { createListenerBus } from "../../../../shared/listener-bus";

type WorkspaceId = string;
type LeafId = string;

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

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value across calls (or React warns "result of getSnapshot should be cached").
// Memoize the getter on (workspaceId, leafId) so the returned function is
// stable and its result is the same Map entry reference each call.
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
