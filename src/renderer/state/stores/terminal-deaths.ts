import { create } from "zustand";
import { defaultTimerScheduler, type TimerScheduler } from "../../../shared/util/timer-scheduler";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

const TERMINAL_DEATH_AGGREGATE_WINDOW_MS = 100;

export interface TerminalDeathAggregate {
  tabIds: string[];
}

interface PendingDeathWindow {
  tabIds: Set<string>;
  timerHandle: unknown;
  getDeadTerminalIds: () => Set<string>;
}

interface TerminalDeathState {
  aggregateByWorkspaceId: Record<string, TerminalDeathAggregate>;
  publishAggregate: (
    workspaceId: string,
    tabIds: string[],
    currentDeadTerminalIds: Set<string>,
  ) => void;
  removeTerminal: (workspaceId: string, tabId: string, currentDeadTerminalIds: Set<string>) => void;
  clearWorkspace: (workspaceId: string) => void;
  reset: () => void;
}

let scheduler: TimerScheduler = defaultTimerScheduler;
const pendingDeathWindows = new Map<string, PendingDeathWindow>();

function clearPendingDeathWindow(workspaceId: string): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (!pending) return;
  scheduler.clearTimeout(pending.timerHandle);
  pendingDeathWindows.delete(workspaceId);
}

function flushDeathWindow(workspaceId: string): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (!pending) return;
  pendingDeathWindows.delete(workspaceId);

  const currentDeadTerminalIds = pending.getDeadTerminalIds();
  const tabIds = [...pending.tabIds].filter((tabId) => currentDeadTerminalIds.has(tabId));
  if (tabIds.length < 2) return;

  useTerminalDeathStore.getState().publishAggregate(workspaceId, tabIds, currentDeadTerminalIds);
}

function aggregateWithCurrentDeadTabs(
  tabIds: Iterable<string>,
  currentDeadTerminalIds: Set<string>,
): TerminalDeathAggregate | null {
  const nextTabIds = [...new Set(tabIds)].filter((tabId) => currentDeadTerminalIds.has(tabId));
  if (nextTabIds.length < 2) return null;
  return { tabIds: nextTabIds };
}

export const useTerminalDeathStore = createTerminalDeathStore();

function createTerminalDeathStore() {
  return create<TerminalDeathState>((set) => {
    registerWorkspaceCleanup((workspaceId) => {
      clearPendingDeathWindow(workspaceId);
      set((state) => {
        if (!(workspaceId in state.aggregateByWorkspaceId)) return state;
        const next = { ...state.aggregateByWorkspaceId };
        delete next[workspaceId];
        return { aggregateByWorkspaceId: next };
      });
    });

    return {
      aggregateByWorkspaceId: {},

      publishAggregate(workspaceId, tabIds, currentDeadTerminalIds) {
        set((state) => {
          const existing = state.aggregateByWorkspaceId[workspaceId]?.tabIds ?? [];
          const aggregate = aggregateWithCurrentDeadTabs(
            [...existing, ...tabIds],
            currentDeadTerminalIds,
          );
          const next = { ...state.aggregateByWorkspaceId };
          if (aggregate) {
            next[workspaceId] = aggregate;
          } else {
            delete next[workspaceId];
          }
          return { aggregateByWorkspaceId: next };
        });
      },

      removeTerminal(workspaceId, tabId, currentDeadTerminalIds) {
        set((state) => {
          const existing = state.aggregateByWorkspaceId[workspaceId];
          if (!existing) return state;
          const aggregate = aggregateWithCurrentDeadTabs(
            existing.tabIds.filter((id) => id !== tabId),
            currentDeadTerminalIds,
          );
          const next = { ...state.aggregateByWorkspaceId };
          if (aggregate) {
            next[workspaceId] = aggregate;
          } else {
            delete next[workspaceId];
          }
          return { aggregateByWorkspaceId: next };
        });
      },

      clearWorkspace(workspaceId) {
        clearPendingDeathWindow(workspaceId);
        set((state) => {
          if (!(workspaceId in state.aggregateByWorkspaceId)) return state;
          const next = { ...state.aggregateByWorkspaceId };
          delete next[workspaceId];
          return { aggregateByWorkspaceId: next };
        });
      },

      reset() {
        for (const workspaceId of pendingDeathWindows.keys()) {
          clearPendingDeathWindow(workspaceId);
        }
        set({ aggregateByWorkspaceId: {} });
      },
    };
  });
}

export function recordTerminalDeathForAggregate(
  workspaceId: string,
  tabId: string,
  getDeadTerminalIds: () => Set<string>,
): void {
  const existing = pendingDeathWindows.get(workspaceId);
  if (existing) {
    existing.tabIds.add(tabId);
    existing.getDeadTerminalIds = getDeadTerminalIds;
    return;
  }

  const pending: PendingDeathWindow = {
    tabIds: new Set([tabId]),
    timerHandle: scheduler.setTimeout(
      () => flushDeathWindow(workspaceId),
      TERMINAL_DEATH_AGGREGATE_WINDOW_MS,
    ),
    getDeadTerminalIds,
  };
  pendingDeathWindows.set(workspaceId, pending);
}

export function releaseTerminalDeathFromAggregate(
  workspaceId: string,
  tabId: string,
  currentDeadTerminalIds: Set<string>,
): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (pending) {
    pending.tabIds.delete(tabId);
    if (pending.tabIds.size === 0) {
      clearPendingDeathWindow(workspaceId);
    }
  }
  useTerminalDeathStore.getState().removeTerminal(workspaceId, tabId, currentDeadTerminalIds);
}

export function configureTerminalDeathAggregationScheduler(
  nextScheduler: TimerScheduler,
): () => void {
  for (const workspaceId of pendingDeathWindows.keys()) {
    clearPendingDeathWindow(workspaceId);
  }
  scheduler = nextScheduler;
  return () => {
    for (const workspaceId of pendingDeathWindows.keys()) {
      clearPendingDeathWindow(workspaceId);
    }
    scheduler = defaultTimerScheduler;
  };
}
