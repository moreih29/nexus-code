import { create } from "zustand";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface ActiveState {
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useActiveStore = create<ActiveState>((set) => ({
  activeWorkspaceId: null,

  setActiveWorkspaceId(id) {
    set({ activeWorkspaceId: id });
  },
}));
