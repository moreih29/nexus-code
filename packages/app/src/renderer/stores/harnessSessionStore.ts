import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  HarnessObserverEvent,
  SessionHistoryEvent,
} from "../../../../shared/src/contracts/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type {
  HarnessObserverBridge,
  HarnessObserverDisposable,
} from "./harnessBadgeStore";

export interface HarnessSessionRef {
  workspaceId: WorkspaceId;
  sessionId: string;
  adapterName: string;
  timestamp: string;
  transcriptPath: string;
  receivedSequence: number;
}

export interface HarnessSessionStoreState {
  sessionByWorkspaceId: Record<string, HarnessSessionRef>;
  applyObserverEvent(event: HarnessObserverEvent): void;
  getSessionForWorkspace(workspaceId: WorkspaceId): HarnessSessionRef | null;
  startObserverSubscription(): void;
  stopObserverSubscription(): void;
}

export type HarnessSessionStore = StoreApi<HarnessSessionStoreState>;

export function createHarnessSessionStore(
  observerBridge: HarnessObserverBridge,
): HarnessSessionStore {
  let subscription: HarnessObserverDisposable | null = null;
  let sequence = 0;

  const store = createStore<HarnessSessionStoreState>((set, get) => ({
    sessionByWorkspaceId: {},
    applyObserverEvent(event) {
      if (event.type !== "harness/session-history") {
        return;
      }

      const sessionRef = sessionRefFromEvent(event, ++sequence);
      set((state) => ({
        sessionByWorkspaceId: {
          ...state.sessionByWorkspaceId,
          [event.workspaceId]: sessionRef,
        },
      }));
    },
    getSessionForWorkspace(workspaceId) {
      return get().sessionByWorkspaceId[workspaceId] ?? null;
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

function sessionRefFromEvent(
  event: SessionHistoryEvent,
  receivedSequence: number,
): HarnessSessionRef {
  return {
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    adapterName: event.adapterName,
    timestamp: event.timestamp,
    transcriptPath: event.transcriptPath,
    receivedSequence,
  };
}
