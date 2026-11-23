import { create } from "zustand";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

interface SessionSeenStore {
  byWorkspace: Record<string, Record<string, number>>;
  markSeen(workspaceId: string, tabId: string, at?: number): void;
  clearWorkspace(workspaceId: string): void;
}

export const useSessionSeenStore = create<SessionSeenStore>((set, get) => {
  registerWorkspaceCleanup((workspaceId) => {
    get().clearWorkspace(workspaceId);
  });

  return {
    byWorkspace: {},

    markSeen(workspaceId, tabId, at = Date.now()) {
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: { ...state.byWorkspace[workspaceId], [tabId]: at },
        },
      }));
    },

    clearWorkspace(workspaceId) {
      if (!(workspaceId in get().byWorkspace)) return;
      set((state) => {
        const { [workspaceId]: _removed, ...rest } = state.byWorkspace;
        return { byWorkspace: rest };
      });
    },
  };
});
