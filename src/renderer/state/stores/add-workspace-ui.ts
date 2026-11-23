import { create } from "zustand";

interface AddWorkspaceUIState {
  addWorkspaceOpen: boolean;
  openAddWorkspace(): void;
  closeAddWorkspace(): void;
}

export const useAddWorkspaceUIStore = create<AddWorkspaceUIState>((set) => ({
  addWorkspaceOpen: false,

  openAddWorkspace() {
    set({ addWorkspaceOpen: true });
  },

  closeAddWorkspace() {
    set({ addWorkspaceOpen: false });
  },
}));
