// src/renderer/state/stores/add-workspace-ui.ts — Add-workspace dialog open state.
//
// Kept as a dedicated store (mirrors `useSettingsUIStore`) so that both
// the App-root mount point and the `workspace.add` keyboard command can
// drive the same controlled `open` prop without prop drilling or
// window-level events.

import { create } from "zustand";

interface AddWorkspaceUIState {
  /** Whether the Add Workspace dialog is open. */
  addWorkspaceOpen: boolean;
  /** Open the dialog. Idempotent — re-open while already open is a no-op. */
  openAddWorkspace(): void;
  /** Close the dialog. */
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
