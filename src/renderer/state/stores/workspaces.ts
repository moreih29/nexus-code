import { create } from "zustand";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcListen } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../lifecycle/workspace-cleanup";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface WorkspacesState {
  workspaces: WorkspaceMeta[];
  setAll: (workspaces: WorkspaceMeta[]) => void;
  upsert: (meta: WorkspaceMeta) => void;
  remove: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkspacesStore = create<WorkspacesState>((set) => {
  // Subscribe to main-process changed events so store stays in sync.
  // `removed` is handled by the central workspace-cleanup registry; only
  // `changed` needs an inline ipcListen here (it's a workspaces-only event,
  // not a generic lifecycle signal).
  if (typeof window !== "undefined") {
    ipcListen("workspace", "changed", (meta) => {
      set((state) => {
        const idx = state.workspaces.findIndex((w) => w.id === meta.id);
        if (idx === -1) {
          // New workspace received via broadcast
          return { workspaces: [...state.workspaces, meta] };
        }
        const next = [...state.workspaces];
        next[idx] = meta;
        return { workspaces: next };
      });
    });
  }

  registerWorkspaceCleanup((id) => {
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
    }));
  });

  return {
    workspaces: [],

    setAll(workspaces) {
      set({ workspaces });
    },

    upsert(meta) {
      set((state) => {
        const idx = state.workspaces.findIndex((w) => w.id === meta.id);
        if (idx === -1) {
          return { workspaces: [...state.workspaces, meta] };
        }
        const next = [...state.workspaces];
        next[idx] = meta;
        return { workspaces: next };
      });
    },

    remove(id) {
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
      }));
    },
  };
});
