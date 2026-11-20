// src/renderer/state/stores/settings-ui.ts — Settings dialog open state.
//
// Kept as a minimal dedicated store so the title-bar ⚙ button and the
// SettingsDialog mount point (App root) can both subscribe to the same
// controlled open state without prop drilling.

import { create } from "zustand";
import type { InstructionScope } from "../../../shared/chat/instructions";

interface SettingsUIState {
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
  /**
   * When set, the dialog should open to this nav tab id.
   * Cleared when the dialog closes.
   */
  initialActiveId?: string;
  initialInstructionScope?: InstructionScope;
  openInstructions(scope: InstructionScope): void;
  /** Open the settings dialog on the default (first) tab. */
  openSettings(): void;
  /** Open the settings dialog navigated to a specific tab. */
  openSettingsAt(activeId: string): void;
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

  openSettingsAt(activeId) {
    set({ settingsOpen: true, initialActiveId: activeId, initialInstructionScope: undefined });
  },

  openInstructions(scope) {
    set({ settingsOpen: true, initialActiveId: "instructions", initialInstructionScope: scope });
  },

  closeSettings() {
    set({ settingsOpen: false, initialActiveId: undefined, initialInstructionScope: undefined });
  },

  toggleSettings() {
    set({ settingsOpen: !get().settingsOpen });
  },
}));
