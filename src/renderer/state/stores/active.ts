import { create } from "zustand";

interface ActiveState {
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
}

export const useActiveStore = create<ActiveState>((set) => ({
  activeWorkspaceId: null,

  setActiveWorkspaceId(id) {
    set({ activeWorkspaceId: id });
  },
}));
