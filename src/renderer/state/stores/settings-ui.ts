// src/renderer/state/stores/settings-ui.ts — Settings dialog open state.
//
// Kept as a minimal dedicated store so the title-bar ⚙ button and the
// SettingsDialog mount point (App root) can both subscribe to the same
// controlled open state without prop drilling.

import { create } from "zustand";

interface SettingsUIState {
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
  /**
   * When set, the dialog should open to this nav tab id.
   * Cleared when the dialog closes.
   */
  initialActiveId?: string;
  /**
   * When set, the Workspaces panel should pre-select this workspace id.
   * Cleared when the dialog closes.
   */
  initialWorkspaceId?: string;
  /** Open the settings dialog on the default (first) tab. */
  openSettings(): void;
  /**
   * Open the settings dialog navigated to a specific tab, optionally
   * with a pre-selected workspace (for the Workspaces panel).
   */
  openSettingsAt(activeId: string, workspaceId?: string): void;
  /** Close the settings dialog and clear all initial* state. */
  closeSettings(): void;
  /** Toggle the settings dialog open state. */
  toggleSettings(): void;
}

export const useSettingsUIStore = create<SettingsUIState>((set, get) => ({
  settingsOpen: false,

  openSettings() {
    set({ settingsOpen: true });
  },

  openSettingsAt(activeId, workspaceId) {
    set({ settingsOpen: true, initialActiveId: activeId, initialWorkspaceId: workspaceId });
  },

  closeSettings() {
    set({ settingsOpen: false, initialActiveId: undefined, initialWorkspaceId: undefined });
  },

  toggleSettings() {
    set({ settingsOpen: !get().settingsOpen });
  },
}));
