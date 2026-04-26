import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  HarnessObserverEvent,
  ToolCallEvent,
} from "../../../../shared/src/contracts/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type {
  HarnessObserverBridge,
  HarnessObserverDisposable,
} from "./harnessBadgeStore";

export const HARNESS_TOOL_FEED_LIMIT = 50;

export interface HarnessToolFeedEntry extends ToolCallEvent {
  receivedSequence: number;
}

export interface HarnessToolFeedStoreState {
  feedByWorkspaceId: Record<string, HarnessToolFeedEntry[]>;
  applyObserverEvent(event: HarnessObserverEvent): void;
  getEntriesForWorkspace(workspaceId: WorkspaceId): HarnessToolFeedEntry[];
  startObserverSubscription(): void;
  stopObserverSubscription(): void;
}

export type HarnessToolFeedStore = StoreApi<HarnessToolFeedStoreState>;

export function createHarnessToolFeedStore(
  observerBridge: HarnessObserverBridge,
): HarnessToolFeedStore {
  let subscription: HarnessObserverDisposable | null = null;
  let sequence = 0;

  const store = createStore<HarnessToolFeedStoreState>((set, get) => ({
    feedByWorkspaceId: {},
    applyObserverEvent(event) {
      if (event.type !== "harness/tool-call") {
        return;
      }

      const entry: HarnessToolFeedEntry = {
        ...event,
        receivedSequence: ++sequence,
      };

      set((state) => {
        const currentEntries = state.feedByWorkspaceId[event.workspaceId] ?? [];
        const nextEntries = [...currentEntries, entry].slice(-HARNESS_TOOL_FEED_LIMIT);

        return {
          feedByWorkspaceId: {
            ...state.feedByWorkspaceId,
            [event.workspaceId]: nextEntries,
          },
        };
      });
    },
    getEntriesForWorkspace(workspaceId) {
      return get().feedByWorkspaceId[workspaceId] ?? [];
    },
    startObserverSubscription() {
      if (subscription) {
        return;
      }

      subscription = observerBridge.onObserverEvent((event) => {
        get().applyObserverEvent(event);
      });
    },
    stopObserverSubscription() {
      subscription?.dispose();
      subscription = null;
    },
  }));

  return store;
}
