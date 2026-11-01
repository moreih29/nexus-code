/**
 * When the user last looked at each terminal, so the inbox drops a session
 * that finished before then. Claude's own completed state is cleared by
 * markSeen; Codex and other agents have no such state, so this is what tells
 * whether their finished turn has been looked at. Kept for this run only, as
 * the output activity it is read against is.
 */

import { create } from "zustand";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

interface SessionSeenStore {
  /** workspaceId → tabId → when the user last had the tab in front of them. */
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
