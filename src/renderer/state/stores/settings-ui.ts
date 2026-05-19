// src/renderer/state/stores/settings-ui.ts — Settings dialog open state.
//
// Kept as a minimal dedicated store so the title-bar ⚙ button and the
// SettingsDialog mount point (App root) can both subscribe to the same
// controlled open state without prop drilling.

import { create } from "zustand";

interface SettingsUIState {
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
  /** Open the settings dialog. */
  openSettings(): void;
  /** Close the settings dialog. */
  closeSettings(): void;
  /** Toggle the settings dialog open state. */
  toggleSettings(): void;
}

export const useSettingsUIStore = create<SettingsUIState>((set, get) => ({
  settingsOpen: false,

  openSettings() {
    set({ settingsOpen: true });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  toggleSettings() {
    set({ settingsOpen: !get().settingsOpen });
  },
}));
