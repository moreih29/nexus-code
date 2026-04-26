import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  HarnessObserverEvent,
  TabBadgeEvent,
  TabBadgeState,
} from "../../../../shared/src/contracts/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";

export type VisibleHarnessBadgeState = Exclude<TabBadgeState, "completed">;

export interface HarnessWorkspaceBadge {
  workspaceId: WorkspaceId;
  state: VisibleHarnessBadgeState;
  sessionId: string;
  adapterName: string;
  timestamp: string;
}

export interface HarnessObserverDisposable {
  dispose(): void;
}

export interface HarnessObserverBridge {
  onObserverEvent(
    listener: (event: HarnessObserverEvent) => void,
  ): HarnessObserverDisposable;
}

interface LatestHarnessEvent {
  sessionId: string;
  timestamp: string;
  epochMs: number;
  sequence: number;
}

export interface HarnessBadgeStoreState {
  badgeByWorkspaceId: Record<string, HarnessWorkspaceBadge>;
  latestEventByWorkspaceId: Record<string, LatestHarnessEvent>;
  applyObserverEvent(event: HarnessObserverEvent): void;
  startObserverSubscription(): void;
  stopObserverSubscription(): void;
}

export type HarnessBadgeStore = StoreApi<HarnessBadgeStoreState>;

export function createHarnessBadgeStore(
  observerBridge: HarnessObserverBridge,
): HarnessBadgeStore {
  let subscription: HarnessObserverDisposable | null = null;
  let sequence = 0;

  const store = createStore<HarnessBadgeStoreState>((set, get) => ({
    badgeByWorkspaceId: {},
    latestEventByWorkspaceId: {},
    applyObserverEvent(event) {
      if (event.type !== "harness/tab-badge") {
        return;
      }

      const nextSequence = ++sequence;
      const incoming = toLatestHarnessEvent(event, nextSequence);
      const current = get().latestEventByWorkspaceId[event.workspaceId];
      if (current && incoming.epochMs < current.epochMs) {
        return;
      }

      set((state) => {
        const latestEventByWorkspaceId = {
          ...state.latestEventByWorkspaceId,
          [event.workspaceId]: incoming,
        };
        const badgeByWorkspaceId = { ...state.badgeByWorkspaceId };

        if (event.state === "completed") {
          delete badgeByWorkspaceId[event.workspaceId];
        } else {
          badgeByWorkspaceId[event.workspaceId] = {
            workspaceId: event.workspaceId,
            state: event.state,
            sessionId: event.sessionId,
            adapterName: event.adapterName,
            timestamp: event.timestamp,
          };
        }

        return { badgeByWorkspaceId, latestEventByWorkspaceId };
      });
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

function toLatestHarnessEvent(
  event: TabBadgeEvent,
  sequence: number,
): LatestHarnessEvent {
  const parsedTimestamp = Date.parse(event.timestamp);
  return {
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    epochMs: Number.isNaN(parsedTimestamp) ? sequence : parsedTimestamp,
    sequence,
  };
}
