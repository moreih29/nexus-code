import { create } from "zustand";
import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

interface ClaudeStatusStore {
  byWorkspace: Record<string, Record<string, StatusEntry>>;
  setMany(entries: StatusEntry[]): void;
  set(entry: StatusEntry): void;
  clearTab(workspaceId: string, tabId: string): void;
  clearWorkspace(workspaceId: string): void;
}

export const EMPTY_TABS: Record<string, StatusEntry> = {};

export const ATTENTION_STATUSES: readonly ClaudeStatus[] = [
  "needsInput",
  "permissionPending",
  "error",
];

export const WORKSPACE_VISIBLE_STATUSES: readonly ClaudeStatus[] = [
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
];

export const STATUS_PRIORITY: Record<ClaudeStatus, number> = {
  idle: 0,
  running: 1,
  completed: 2,
  needsInput: 3,
  error: 4,
  permissionPending: 5,
};

export const useClaudeStatusStore = create<ClaudeStatusStore>((set, get) => {
  registerWorkspaceCleanup((workspaceId) => {
    get().clearWorkspace(workspaceId);
  });

  return {
    byWorkspace: {},

    setMany(entries) {
      const next: Record<string, Record<string, StatusEntry>> = {};
      for (const entry of entries) {
        if (!next[entry.workspaceId]) {
          next[entry.workspaceId] = {};
        }
        next[entry.workspaceId][entry.tabId] = entry;
      }
      set({ byWorkspace: next });
    },

    set(entry) {
      set((state) => {
        const wsRecord = state.byWorkspace[entry.workspaceId];
        const existing = wsRecord?.[entry.tabId];

        if (
          existing !== undefined &&
          existing.status === entry.status &&
          existing.message === entry.message &&
          existing.since === entry.since &&
          existing.prompt === entry.prompt
        ) {
          return state;
        }

        return {
          byWorkspace: {
            ...state.byWorkspace,
            [entry.workspaceId]: {
              ...(wsRecord ?? {}),
              [entry.tabId]: entry,
            },
          },
        };
      });
    },

    clearTab(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const next = { ...wsRecord };
        delete next[tabId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: next,
          },
        };
      });
    },

    clearWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
    },
  };
});

export function selectStatusForTab(
  state: ClaudeStatusStore,
  workspaceId: string,
  tabId: string,
): StatusEntry | undefined {
  return state.byWorkspace[workspaceId]?.[tabId];
}

export function selectWorkspaceAggregateStatus(
  state: ClaudeStatusStore,
  workspaceId: string,
): { status: ClaudeStatus; count: number } | null {
  const wsRecord = state.byWorkspace[workspaceId];
  if (!wsRecord) return null;

  const entries = Object.values(wsRecord);
  if (entries.length === 0) return null;

  let topPriority = -1;
  let topStatus: ClaudeStatus = "idle";
  let attentionCount = 0;

  for (const entry of entries) {
    const priority = STATUS_PRIORITY[entry.status];
    if (priority > topPriority) {
      topPriority = priority;
      topStatus = entry.status;
    }
    if (ATTENTION_STATUSES.includes(entry.status)) {
      attentionCount++;
    }
  }

  return { status: topStatus, count: attentionCount };
}

export function selectIsWorkspaceAttention(state: ClaudeStatusStore, workspaceId: string): boolean {
  const aggregate = selectWorkspaceAggregateStatus(state, workspaceId);
  return aggregate !== null && ATTENTION_STATUSES.includes(aggregate.status);
}

export function isAttentionRequired(status: ClaudeStatus | undefined): boolean {
  return status !== undefined && ATTENTION_STATUSES.includes(status);
}
